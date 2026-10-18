import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { authorization, type AdminConfig } from "../server/admin.js";
import { Configuration, defaults, SettingsSchema } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import {
  CheckSchema,
  ChecksSchema,
  type CheckConfig,
} from "../server/check-config.js";
import {
  configAPI,
  synchronize,
  publicDefinition,
} from "../server/config-api.js";
import { TargetPolicy } from "../server/targets.js";
import { probe } from "../server/probe.js";
const check = CheckSchema.parse({
  id: "existing",
  name: "Existing",
  hostId: "host",
  type: "http",
  url: "http://127.0.0.1/",
  failureThreshold: 1,
}) as Extract<CheckConfig, { type: "http" }>;
const seed = ChecksSchema.parse({ checks: [check] });
async function fixture(t: test.TestContext) {
  const { privateKey, publicKey } = await generateKeyPair("RS256"),
    key = await exportJWK(publicKey);
  key.kid = "test";
  const admin: AdminConfig = {
    issuer: "https://example.cloudflareaccess.com",
    audience: "hostboard",
    emails: ["admin@example.com"],
    origin: "https://board.example.com",
    targets: [{ host: "127.0.0.1", port: 80, addresses: ["127.0.0.1"] }],
  };
  const sign = async (
    patch: Record<string, unknown> = {},
    keyOverride = privateKey,
    alg = "RS256",
  ) =>
    new SignJWT({ email: "admin@example.com", ...patch })
      .setProtectedHeader({ alg, kid: "test" })
      .setIssuer(admin.issuer)
      .setAudience(admin.audience)
      .setSubject("admin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keyOverride);
  const token = await sign(),
    store = new Configuration(":memory:", seed);
  let sends = 0,
    fail = false;
  const monitor = new Monitor(store.runtime(), store.db, {
    provider: "Isolated test SMTP",
    send: async () => {
      sends++;
      if (fail) throw Error("PRIVATE SMTP SECRET");
    },
  });
  synchronize(store, monitor);
  const app = express();
  app.use(
    "/api",
    configAPI(
      store,
      monitor,
      admin,
      ["host"],
      authorization(admin, createLocalJWKSet({ keys: [key] })),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => {
    monitor.stop();
    store.db.close();
    server.closeAllConnections();
    server.close();
  });
  const call = async (
    route: string,
    body?: unknown,
    options: {
      token?: string;
      origin?: string;
      header?: string;
      method?: string;
    } = {},
  ) =>
    fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${route}`,
      {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "Cf-Access-Jwt-Assertion": options.token ?? token,
          Origin: options.origin ?? admin.origin,
          "X-Hostboard-Request": options.header ?? "1",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  return {
    call,
    store,
    monitor,
    sign,
    admin,
    get sends() {
      return sends;
    },
    set fail(v: boolean) {
      fail = v;
    },
  };
}
test("configuration imports ten checks once, persists across restarts, retains incidents and presentation identities", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hostboard-v4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "monitor.sqlite");
  const seed = ChecksSchema.parse({
    checks: Array.from({ length: 10 }, (_, i) => ({
      ...check,
      id: `check-${i}`,
    })),
  });
  let store = new Configuration(file, seed);
  let monitor = new Monitor(store.runtime(), store.db, null, 1000);
  synchronize(store, monitor);
  monitor.record(
    store.runtime().checks[0],
    { ok: false, responseMs: 1, reason: "Failure" },
    1000,
  );
  const original = store.checks()[0];
  store.atomic(() => {
    store.saveCheck({
      ...original,
      definition: {
        ...original.definition,
        name: "Renamed",
        group: "Infrastructure",
      },
    });
    synchronize(store, monitor);
  });
  assert.equal(monitor.view(1000).activeIncidents?.[0].id, 1);
  assert.equal(
    monitor.db.prepare("SELECT count(*) n FROM samples").get()?.n,
    1,
  );
  store.atomic(() => {
    store.saveCheck({ ...store.checks()[0], enabled: false });
    synchronize(store, monitor);
  });
  assert.equal(monitor.view(1000).checks[0].state, "disabled");
  assert.equal(monitor.view(1000).incidents[0].endedAt, null);
  store.saveSettings({
    ...defaults,
    general: { ...defaults.general, refreshSeconds: 45 },
  });
  store.db.close();
  store = new Configuration(file, ChecksSchema.parse({ checks: [] }));
  monitor = new Monitor(store.runtime(), store.db, null, 1100);
  synchronize(store, monitor);
  assert.equal(store.checks().length, 10);
  assert.equal(store.settings().general.refreshSeconds, 45);
  assert.equal(monitor.view(1100).checks[0].state, "disabled");
  assert.equal(monitor.view(1100).incidents[0].id, 1);
  store.saveCheck({ ...store.checks()[0], deleted: true });
  synchronize(store, monitor);
  assert.equal(monitor.view(1100).checks.length, 9);
  assert.equal(monitor.view(1100).incidents[0].id, 1);
  store.saveCheck({ ...store.checks()[0], deleted: false, enabled: true });
  synchronize(store, monitor);
  assert.equal(monitor.view(1100).checks.length, 10);
  assert.equal(
    monitor.db.prepare("SELECT count(*) n FROM samples WHERE ok IS NOT NULL").get()?.n,
    1,
  );
  store.db.close();
});
test("write endpoints validate signed identities, reject forged, expired, wrong audience/issuer and cross-origin requests", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("admin/config")).status, 200);
  for (const token of [
    "",
    "forged",
    await f.sign({ email: "reader@example.com" }),
    await new SignJWT({ email: "admin@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(f.admin.issuer)
      .setAudience("wrong")
      .setSubject("x")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign((await generateKeyPair("RS256")).privateKey),
  ])
    assert.equal(
      (await f.call("admin/config", undefined, { token })).status,
      403,
    );
  // Claims are checked using the trusted fixture key, not just an invalid signature.
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = await exportJWK(publicKey);
  key.kid = "test";
  const guard = authorization(f.admin, createLocalJWKSet({ keys: [key] }));
  for (const patch of [
    {
      iss: "https://other.cloudflareaccess.com",
      aud: f.admin.audience,
      exp: Date.now() / 1000 + 60,
    },
    { iss: f.admin.issuer, aud: "wrong", exp: Date.now() / 1000 + 60 },
    { iss: f.admin.issuer, aud: f.admin.audience, exp: 1 },
  ]) {
    const jwt = await new SignJWT({
      email: "admin@example.com",
      sub: "x",
      iat: Math.floor(Date.now() / 1000),
      ...patch,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(privateKey);
    assert.equal(await guard.identity({ get: () => jwt } as any), null);
  }
  const body = { revision: f.store.revision(), settings: f.store.settings() };
  assert.equal(
    (
      await f.call("admin/settings", body, {
        method: "PUT",
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("admin/settings", body, { method: "PUT", header: "" }))
      .status,
    403,
  );
  assert.equal(
    (await f.call("admin/settings", body, { method: "PUT", token: "" })).status,
    403,
  );
  const disabled = authorization(null);
  assert.equal(
    await disabled.identity({ get: () => awaitNever() } as any),
    null,
  );
  function awaitNever() {
    throw Error("Should not inspect header when disabled");
  }
  assert.equal(f.store.revision(), 1);
});
test("HTTP API adds, edits, disables, archives/restores without deleting history; optimistic revisions and validation", async (t) => {
  const f = await fixture(t);
  const definition = publicDefinition(check);
  let r = await f.call("admin/checks", {
    revision: 1,
    definition,
    enabled: true,
  });
  assert.equal(r.status, 201);
  const added = await r.json();
  const c = f.store.checks().find((c) => c.definition.id === added.id)!;
  f.monitor.record(
    c.definition,
    { ok: false, responseMs: 1, reason: "controlled" },
    1000,
  );
  r = await f.call(
    `admin/checks/${added.id}`,
    {
      revision: f.store.revision(),
      definition: { ...definition, name: "Changed", group: "Infrastructure" },
      enabled: false,
    },
    { method: "PUT" },
  );
  assert.equal(r.status, 200);
  assert.equal(
    f.monitor.view(1000).checks.find((c) => c.id === added.id)?.state,
    "disabled",
  );
  assert.equal(f.monitor.view(1000).incidents[0].id, 1);
  assert.equal(
    (await f.call("admin/checks", { revision: 1, definition, enabled: true }))
      .status,
    409,
  );
  for (const patch of [
    { timeoutMs: 0 },
    { timeoutMs: 30000, intervalSeconds: 10 },
    { url: "file:///etc/passwd" },
    { url: "http://169.254.169.254/latest/meta-data" },
    { url: "http://127.0.0.1:22/" },
    { headersEnv: "SECRET" },
    { url: "http://user:pass@127.0.0.1/" },
  ])
    assert.equal(
      (
        await f.call("admin/checks", {
          revision: f.store.revision(),
          definition: { ...definition, ...patch },
          enabled: true,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.call(`admin/checks/${added.id}/archive`, {
        revision: f.store.revision(),
        confirm: "ARCHIVE",
      })
    ).status,
    200,
  );
  assert.equal(
    f.monitor.view(1000).checks.some((c) => c.id === added.id),
    false,
  );
  assert.equal(f.monitor.view(1000).incidents[0].id, 1);
  assert.equal(
    (
      await f.call(
        `admin/checks/${added.id}`,
        { revision: f.store.revision(), definition, enabled: true },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  assert.equal(
    f.monitor.view(1000).checks.some((c) => c.id === added.id),
    true,
  );
});
test("target policy rejects rebinding, mixed answers, metadata, alternate IPv4 and unapproved ports; pins HTTP and redirects", async (t) => {
  const policy = new TargetPolicy(
    [{ host: "allowed.test", port: 80, addresses: ["127.0.0.1"] }],
    (async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]) as any,
  );
  await assert.rejects(
    () => policy.validate({ ...check, url: "http://allowed.test/" }),
    /not permitted/,
  );
  for (const ip of [
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fd00:ec2::254",
  ]) {
    const p = new TargetPolicy([{ host: ip, port: 80, addresses: [ip] }]);
    await assert.rejects(() =>
      p.address({ ...check, type: "tcp", address: ip, port: 80 }),
    );
  }
  let outside = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
    } else if (req.url === "/same") {
      res.writeHead(302, { location: "/ok" });
    } else {
      outside++;
      res.statusCode = 200;
    }
    res.end("OK");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  let answers = 0;
  const pinned = new TargetPolicy(
    [{ host: "allowed.test", port, addresses: ["127.0.0.1"] }],
    (async () => {
      answers++;
      return [{ address: "127.0.0.1", family: 4 }];
    }) as any,
  );
  const c = CheckSchema.parse({
    ...check,
    url: `http://allowed.test:${port}/same`,
    followRedirects: true,
  });
  assert.equal((await probe(c, pinned)).ok, true);
  assert.equal(outside, 1);
  assert(answers >= 2);
  assert.match(
    (
      await probe(
        CheckSchema.parse({
          ...c,
          url: `http://allowed.test:${port}/redirect`,
        }),
        pinned,
      )
    ).reason,
    /Cross-origin/,
  );
  assert.equal(outside, 1);
  const rebind = new TargetPolicy(
    [{ host: "allowed.test", port, addresses: ["127.0.0.1"] }],
    (async () => [{ address: "10.0.0.1", family: 4 }]) as any,
  );
  assert.equal((await probe(c, rebind)).ok, null);
});
test("notification preferences, actual test-provider delivery/failure and rate limits are durable and secret-free", async (t) => {
  const f = await fixture(t);
  const settings = f.store.settings();
  settings.notifications = {
    enabled: false,
    recipients: ["recipient@example.com"],
    minimumSeverity: "critical",
    cooldownSeconds: 120,
    recovery: false,
  };
  assert.equal(
    (
      await f.call(
        "admin/settings",
        { revision: 1, settings },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  f.monitor.record(
    check,
    { ok: false, responseMs: 1, reason: "Controlled" },
    1000,
  );
  await f.monitor.dispatch(1000);
  assert.equal(f.sends, 0);
  assert.equal(
    f.monitor.view(1000).incidents[0].notifications[0].state,
    "suppressed",
  );
  assert.equal((await f.call("admin/mail-test", {})).status, 200);
  assert.equal(f.sends, 1);
  assert.equal((await f.call("admin/mail-test", {})).status, 429);
  assert.equal(f.sends, 1);
  f.store.db.exec("DELETE FROM action_limits WHERE action='mail-test'");
  f.fail = true;
  const r = await f.call("admin/mail-test", {});
  assert.equal(r.status, 502);
  assert(!JSON.stringify(await r.json()).includes("PRIVATE"));
  assert.deepEqual(
    f.store.db
      .prepare("SELECT state FROM mail_tests ORDER BY id")
      .all()
      .map((r) => r.state),
    ["SMTP accepted", "Delivery failed"],
  );
  assert.equal(
    SettingsSchema.safeParse({
      ...settings,
      retention: { sampleDays: 1, incidentDays: 1 },
    }).success,
    false,
  );
});

test("retention reductions require confirmation and consistent recovery backups; failed changes roll back", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hostboard-retention-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Configuration(path.join(dir, "monitor.sqlite"), seed);
  store.saveSettings({
    ...defaults,
    retention: { sampleDays: 90, incidentDays: 0 },
  });
  await store.backup();
  const { readdirSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const file = readdirSync(path.join(dir, "backups"))[0];
  const saved = new DatabaseSync(path.join(dir, "backups", file));
  assert.equal(
    saved.prepare("PRAGMA integrity_check").get()?.integrity_check,
    "ok",
  );
  assert.equal(
    JSON.parse(
      String(saved.prepare("SELECT value FROM app_settings").get()?.value),
    ).retention.sampleDays,
    90,
  );
  saved.close();
  const before = store.revision();
  assert.throws(() =>
    store.atomic(() => {
      store.saveSettings(defaults);
      throw Error("Controlled write failure");
    }),
  );
  assert.equal(store.settings().retention.sampleDays, 90);
  assert.equal(store.revision(), before);
  store.db.close();
  const f = await fixture(t);
  const settings = f.store.settings();
  settings.retention.sampleDays = 90;
  assert.equal(
    (
      await f.call(
        "admin/settings",
        { revision: f.store.revision(), settings },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  settings.retention.sampleDays = 30;
  assert.equal(
    (
      await f.call(
        "admin/settings",
        { revision: f.store.revision(), settings },
        { method: "PUT" },
      )
    ).status,
    400,
  );
  assert.equal(f.store.settings().retention.sampleDays, 90);
  assert.equal(
    (
      await f.call(
        "admin/settings",
        { revision: f.store.revision(), settings, confirmRetention: true },
        { method: "PUT" },
      )
    ).status,
    200,
  );
  assert.equal(f.store.settings().retention.sampleDays, 30);
});

test("general and presentation updates preserve in-flight unrelated checks; disabling discards only that check observation", async (t) => {
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  let ready = new Promise<void>((r) => (entered = r));
  const server = http.createServer((_req, res) => {
    release = () => {
      res.statusCode = 503;
      res.end("controlled");
    };
    entered?.();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const c = CheckSchema.parse({
    ...check,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    intervalSeconds: 10,
    notify: false,
  });
  const m = new Monitor(ChecksSchema.parse({ checks: [c] }), ":memory:", null);
  t.after(() => {
    m.stop();
    server.closeAllConnections();
    server.close();
    m.db.close();
  });
  m.start();
  await ready;
  m.configure(
    ChecksSchema.parse({
      checks: [
        { ...c, name: "Renamed during observation", group: "Infrastructure" },
      ],
    }),
  );
  release!();
  const deadline = Date.now() + 1000;
  while (!m.view().checks[0].checkedAt && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.view().checks[0].state, "down");
  assert.equal(m.view().incidents[0].name, "Renamed during observation");
  ready = new Promise<void>((r) => (entered = r));
  m.db.prepare("UPDATE checks SET checked=NULL").run();
  await ready;
  m.configure(m.config, undefined, new Set([c.id]));
  release!();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.db.prepare("SELECT COUNT(*) n FROM samples WHERE ok IS NOT NULL").get()?.n, 1);
  assert.equal(m.db.prepare("SELECT COUNT(*) n FROM samples WHERE ok IS NULL").get()?.n, 1, "disable records an explicit unknown boundary");
  assert.equal(m.view().checks[0].state, "disabled");
});
