import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Monitor } from "../server/monitor.js";
import { ChecksSchema, CheckSchema } from "../server/check-config.js";
import { Configuration } from "../server/settings.js";
import { synchronize } from "../server/config-api.js";
import type { Message } from "../server/notifications.js";

const base = CheckSchema.parse({
  id: "a",
  name: "Failing A",
  hostId: "host",
  type: "http",
  url: "http://127.0.0.1/",
  intervalSeconds: 10,
  timeoutMs: 9000,
  failureThreshold: 3,
  cooldownSeconds: 0,
});
const bad = { ok: false, responseMs: 6000, reason: "HTTP 503" };
const good = { ok: true, responseMs: 1, reason: "HTTP 200" };
const config = (checks = [base]) => ChecksSchema.parse({ checks });

test("HB-002 slow failures and timeouts reach threshold; gaps, successes and schedule edits reset evidence", () => {
  for (const duration of [6000, 9000]) {
    const m = new Monitor(config(), ":memory:", null, 1000);
    for (let i = 0; i < 3; i++)
      m.record(
        base,
        { ...bad, responseMs: duration },
        1000 + i * (10 + duration / 1000),
      );
    assert.equal(m.view(1040).incidents.length, 1);
    assert.equal(m.view(1040).checks[0].failures, 3);
    m.record(base, good, 1050);
    assert.equal(m.view(1050).activeIncidents?.length, 0);
    assert.equal(m.view(1050).incidents[0].resolution, "Reachability restored");
    m.db.close();
  }
  const m = new Monitor(config(), ":memory:", null, 1000);
  m.record(base, bad, 1000);
  m.record(base, bad, 1016);
  m.record(base, bad, 1052); // start=1046: a real missing interval since 1016.
  assert.equal(m.view(1052).checks[0].failures, 1);
  m.record(base, good, 1062);
  m.record(base, bad, 1078);
  m.record(base, bad, 1094);
  assert.equal(m.view(1094).incidents.length, 0);
  m.record(
    base,
    { ok: null, responseMs: null, reason: "Monitor unavailable" },
    1104,
  );
  m.record(base, bad, 1120);
  assert.equal(m.view(1120).checks[0].failures, 1);
  const changed = CheckSchema.parse({ ...base, intervalSeconds: 20 });
  m.configure(config([changed]), 1121);
  m.record(changed, bad, 1140);
  assert.equal(m.view(1140).checks[0].failures, 1);
  m.record(changed, good, 1160);
  m.record(changed, good, 1300);
  assert(
    m.view(1300).checks[0].summary.unknownSeconds > 0,
    "missing observations are never credited as uptime",
  );
  m.db.close();
});

test("HB-001 unrelated outbox keys progress with backlog, cooldowns, blocked transport, and restart", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-fair-mail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checks = Array.from({ length: 9 }, (_, i) =>
    CheckSchema.parse({
      ...base,
      id: "c" + i,
      name: "Check " + i,
      failureThreshold: 1,
    }),
  );
  const file = path.join(dir, "monitor.sqlite");
  const sent: Message[] = [];
  let attempts = 0;
  const delivery = {
    provider: "controlled",
    send: async (message: Message) => {
      if (message.subject.includes("Check 0")) {
        attempts++;
        throw Error("private rejection");
      }
      sent.push(message);
    },
  };
  let m = new Monitor(config(checks), file, delivery, 1000);
  for (let i = 0; i < 4; i++) {
    m.record(checks[0], bad, 1000 + i * 20);
    m.record(checks[0], good, 1010 + i * 20);
  }
  for (const c of checks.slice(1)) m.record(c, bad, 1080);
  await m.dispatch(1080);
  await m.dispatch(1081);
  assert.equal(
    sent.length,
    8,
    "all independent alerts within two bounded flushes",
  );
  assert.equal(attempts, 1);
  assert.equal(
    (
      m.db
        .prepare("SELECT nextAttempt n FROM notifications WHERE id=1")
        .get() as { n: number }
    ).n,
    1110,
  );
  m.db.close();
  m = new Monitor(config(checks), file, delivery, 1082);
  await m.dispatch(1082);
  assert.equal(attempts, 1, "retry deadline persists");
  await m.dispatch(1110);
  assert.equal(attempts, 2);
  assert(!JSON.stringify(m.view(1110)).includes("private rejection"));
  for (const c of checks.slice(1)) m.record(c, good, 1111);
  await m.dispatch(1111);
  await m.dispatch(1112);
  assert.equal(sent.length, 16);
  for (const incident of m
    .view(1112)
    .incidents.filter((i) => i.checkId !== "c0"))
    assert.deepEqual(
      incident.notifications.map((n) => n.event),
      ["outage", "recovery"],
    );
  m.db.close();
  // A transport still awaiting completion occupies one slot, not the whole dispatcher.
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const hanging = new Monitor(
    config(checks),
    ":memory:",
    {
      provider: "controlled",
      send: async (message) => {
        if (message.subject.includes("Check 0")) await blocked;
        else sent.push(message);
      },
    },
    2000,
  );
  hanging.record(checks[0], bad, 2000);
  const first = hanging.dispatch(2000);
  for (const c of checks.slice(1)) hanging.record(c, bad, 2001);
  await hanging.dispatch(2001);
  await hanging.dispatch(2002);
  assert.equal(sent.length, 24);
  release();
  await first;
  hanging.db.close();
});

test("HB-004/005 migration preserves samples; revisions, renames, disable, archive and restore retain correct history", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-generations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "monitor.sqlite");
  // Construct the actual schema-1 layout, not a database already created by new code.
  const db = new DatabaseSync(file);
  db.exec(
    `PRAGMA user_version=1;CREATE TABLE samples(checkId TEXT,time REAL,ok INTEGER,ms REAL,interval REAL,PRIMARY KEY(checkId,time));INSERT INTO samples VALUES('a',1000,1,1,10);`,
  );
  const m = new Monitor(config(), db, null, 1000);
  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  assert.equal(m.view(1000).checks[0].lastSuccessfulAt, 1000);
  const renamed = {
    ...base,
    name: "New name",
    group: "Infrastructure" as const,
  };
  m.configure(config([renamed]), 1001);
  assert.equal(m.view(1001).checks[0].generation, 1);
  const replacement = { ...renamed, url: "http://127.0.0.1/replacement" };
  m.configure(config([replacement]), 1002);
  assert.equal(m.view(1002).checks[0].lastSuccessfulAt, null);
  assert.equal(m.view(1002).checks[0].summary.observedSeconds, 0);
  assert.equal(m.historyFor("a", 1, 1002)?.lastSuccessfulAt, 1000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM samples").get()?.n, 1);
  // Same timestamp observations belonging to different identities must coexist.
  m.record(replacement, good, 1000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM samples").get()?.n, 2);
  m.db.close();
  const reopened = new Monitor(config([replacement]), file, null, 1003);
  assert.equal(reopened.view(1003).checks[0].generation, 2);
  assert.equal(reopened.historyFor("a", 1, 1003)?.lastSuccessfulAt, 1000);
  assert.equal(
    reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    "ok",
  );
  reopened.db.close();
  const s = new Configuration(
    ":memory:",
    config([{ ...base, failureThreshold: 1 }]),
  );
  const monitor = new Monitor(
    s.runtime(),
    s.db,
    {
      provider: "never called",
      send: async () => {
        throw Error("Must remain suppressed");
      },
    },
    1000,
  );
  synchronize(s, monitor);
  const c = s.runtime().checks[0];
  monitor.record(c, bad, 1000);
  s.atomic(() => {
    s.saveCheck({ definition: c, enabled: false, deleted: false });
    synchronize(s, monitor);
  });
  assert.equal(
    monitor.view(1001).activeIncidents?.length,
    1,
    "temporary disable keeps incident open with a gap",
  );
  assert.equal(monitor.view(1001).activeIncidents?.[0].monitoringGap, true);
  s.atomic(() => {
    s.saveCheck({ definition: c, enabled: false, deleted: true });
    synchronize(s, monitor);
  });
  const archived = monitor.view(1002);
  assert.equal(archived.checks.length, 0);
  assert.equal(archived.activeIncidents?.length, 0);
  assert.match(archived.incidents[0].resolution!, /Monitoring discontinued/);
  assert(
    archived.incidents[0].notifications.every((n) => n.state === "suppressed"),
  );
  s.atomic(() => {
    s.saveCheck({ definition: c, enabled: true, deleted: false });
    synchronize(s, monitor);
  });
  assert.equal(monitor.view().checks[0].generation, 1);
  monitor.record(c, good, Date.now() / 1000);
  assert.equal(
    monitor.view().incidents.length,
    1,
    "restore does not invent a recovery",
  );
  assert.equal(s.checks()[0].deleted, false);
  s.db.close();
});

// Exercise native HTTP probes; only the wall clock and interval driver are controlled.
async function schedulerScenario(count: number, waves: number, duration = 9.9) {
  let now = 1000000,
    tick!: () => void;
  const realNow = Date.now,
    realInterval = globalThis.setInterval;
  const held: http.ServerResponse[] = [];
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    hits.set(req.url!, (hits.get(req.url!) ?? 0) + 1);
    held.push(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Date.now = () => now * 1000;
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn;
    return 0;
  }) as unknown as typeof setInterval;
  const port = (server.address() as import("node:net").AddressInfo).port;
  const checks = Array.from({ length: count }, (_, i) => ({
    ...base,
    id: "c" + i,
    name: "Check " + i,
    url: `http://127.0.0.1:${port}/${i}`,
    timeoutMs: 9900,
    notify: false,
  }));
  const m = new Monitor(config(checks), ":memory:", null, now);
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000 && !predicate(); i++) await turn();
    assert(predicate(), "native probes settled");
  };
  try {
    m.start();
    for (let wave = 0; wave < waves; wave++) {
      for (
        let i = 0;
        i < 40 && !(m as unknown as { running: Set<string> }).running.size;
        i++
      ) {
        now++;
        tick();
      }
      await settle(() => held.length > 0);
      assert(held.length <= 8, "worker cap remains eight");
      const start = now;
      for (let s = 1; s < duration; s++) {
        now = start + s;
        tick();
        await turn();
      }
      now = start + duration;
      for (const res of held.splice(0)) {
        res.statusCode = 503;
        res.end("delayed 503");
      }
      await settle(
        () => !(m as unknown as { running: Set<string> }).running.size,
      );
      now = start + Math.ceil(duration);
      tick();
    }
    return {
      hits: new Map(hits),
      view: m.view(now),
      samples: m.db.prepare("SELECT COUNT(*) n FROM samples").get()?.n,
    };
  } finally {
    m.stop();
    Date.now = realNow;
    globalThis.setInterval = realInterval;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    m.db.close();
  }
}

test("HB-002 deterministic native slow HTTP 503 reproduction opens an incident", async () => {
  const result = await schedulerScenario(1, 6, 6);
  assert(result.view.incidents.length === 1);
  assert(result.view.checks[0].failures >= 3);
});

test("HB-003 all 100 checks receive bounded opportunities under sustained slow load", async () => {
  const result = await schedulerScenario(100, 39);
  assert.equal(result.hits.size, 100);
  assert(
    result.view.checks.every((c) => c.checkedAt !== null),
    "no check remains unobserved",
  );
  assert(
    Math.max(...result.hits.values()) - Math.min(...result.hits.values()) <= 1,
    "fair distribution under overload",
  );
  assert.equal(
    result.view.healthy,
    false,
    "overload is visible as monitoring unavailable",
  );
});

test("HB-003 real 100-check mixed slow/fast load has no overlapping work and bounded coverage", async (t) => {
  const active = new Set<string>(),
    hits = new Map<string, number>();
  let peak = 0,
    overlap = false;
  const server = http.createServer((req, res) => {
    const id = req.url!;
    if (active.has(id)) overlap = true;
    active.add(id);
    peak = Math.max(peak, active.size);
    hits.set(id, (hits.get(id) ?? 0) + 1);
    const timer = setTimeout(
      () => {
        active.delete(id);
        res.end("ok");
      },
      Number(id.slice(1)) < 80 ? 1500 : 5,
    );
    res.on("close", () => {
      clearTimeout(timer);
      active.delete(id);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const checks = Array.from({ length: 100 }, (_, i) => ({
    ...base,
    id: "c" + i,
    name: "Check " + i,
    url: `http://127.0.0.1:${port}/${i}`,
    notify: false,
  }));
  const m = new Monitor(config(checks), ":memory:", null);
  const started = Date.now();
  try {
    m.start();
    const deadline = started + 65000;
    while (hits.size < 100 || Math.min(...hits.values()) < 2) {
      assert(
        Date.now() < deadline,
        `coverage deadline: ${hits.size}/100 checks`,
      );
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(!overlap);
    assert(peak <= 8);
    assert(m.view().checks.every((c) => c.checkedAt !== null));
    t.diagnostic(
      `100 checks (80 x 1500ms, 20 x 5ms) observed twice in ${Date.now() - started}ms; peak workers ${peak}`,
    );
  } finally {
    m.stop();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (
      let i = 0;
      i < 100 && (m as unknown as { running: Set<string> }).running.size;
      i++
    )
      await turn();
    m.db.close();
  }
});
