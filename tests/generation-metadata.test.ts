import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Configuration } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import { migrateMonitor } from "../server/monitor-schema.js";
import { ChecksSchema } from "../server/check-config.js";

const seed = ChecksSchema.parse({
  checks: [
    {
      id: "a",
      name: "Original",
      hostId: "host",
      type: "http",
      url: "https://example.test/token/SECRET-PATH?arbitrary=SECRET-QUERY",
      expectedContent: "SECRET-CONTENT",
      headersEnv: "PRIVATE_HEADERS",
      intervalSeconds: 10,
    },
  ],
});
const fixture = readFileSync(
  new URL("./fixtures/monitor-schema2.sql", import.meta.url),
  "utf8",
);

test("HB-004 durable safe generation definitions survive rename, replacement, archive and restore", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "hb-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "monitor.sqlite");
  const store = new Configuration(file, seed);
  const m = new Monitor(store.runtime(), store.db, null, 1000);
  const check = seed.checks[0];
  m.record(check, { ok: true, responseMs: 1, reason: "ok" }, 1001);
  const original = m.historyFor("a", 1, 1002, true)!;
  assert.equal(original.metadataStatus, "available");
  assert.equal(original.targetMetadata.name, "Original");
  assert.equal(original.targetMetadata.target, "https://example.test");
  assert.deepEqual(original.targetMetadata.expectedStatuses, [200]);
  assert.equal(original.targetMetadata.contentMatchConfigured, true);
  assert(!JSON.stringify(original).includes("SECRET"));
  assert(!JSON.stringify(original).includes("PRIVATE_HEADERS"));
  assert(
    !JSON.stringify(m.historyFor("a", 1, 1002)).includes("targetMetadata"),
  );
  assert(!JSON.stringify(m.generations("a")).includes("targetMetadata"));
  const rename = {
    ...check,
    name: "Renamed",
    group: "Infrastructure" as const,
  };
  m.configure(ChecksSchema.parse({ checks: [rename] }), 1003);
  assert.equal(m.generations("a").length, 1);
  assert.equal(
    m.historyFor("a", 1, 1003, true)!.targetMetadata.name,
    "Original",
  );
  const changed = {
    ...rename,
    url: "https://replacement.test/new/SECRET",
    expectedStatuses: [204],
  };
  m.configure(ChecksSchema.parse({ checks: [changed] }), 1004);
  assert.equal(m.historyFor("a", 1, 1004, true)!.endedAt, 1004);
  assert.equal(
    m.historyFor("a", 1, 1004, true)!.supersededReason,
    "Evaluation configuration changed",
  );
  assert.equal(
    m.historyFor("a", 2, 1004, true)!.targetMetadata.target,
    "https://replacement.test",
  );
  assert.equal(m.view(1004).checks[0].lastSuccessfulAt, null);
  assert.equal(m.view(1004).checks[0].summary.observedSeconds, 0);
  const tcp = {
    id: "a",
    name: "TCP",
    hostId: "new-host",
    type: "tcp",
    address: "192.0.2.1",
    port: 443,
    intervalSeconds: 10,
  };
  const tcpConfig = ChecksSchema.parse({ checks: [tcp] });
  m.configure(tcpConfig, 1005);
  const before = m.historyFor("a", 3, 1005, true)!;
  assert.equal(before.targetMetadata.protocol, "tcp");
  assert.equal(before.targetMetadata.target, "192.0.2.1:443");
  assert.equal(before.targetMetadata.hostId, "new-host");
  m.configure(tcpConfig, 1006, new Set(["a"]), new Set(["a"]));
  m.configure(tcpConfig, 1007, new Set(), new Set());
  assert.deepEqual(m.historyFor("a", 3, 1005, true), before);
  store.db.close();
  const reopened = new Monitor(tcpConfig, file, null, 1008);
  assert.deepEqual(reopened.historyFor("a", 3, 1005, true), before);
  assert.equal(
    reopened.historyFor("a", 1, 1005, true)!.targetMetadata.name,
    "Original",
  );
  reopened.db.close();
});

const snapshot = (db: DatabaseSync) =>
  Object.fromEntries(
    [
      "samples",
      "notifications",
      "external_incidents",
      "service_config",
      "app_settings",
      "check_evaluation",
      "config_audit",
    ].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );

test("schema 2 actual release fixture migrates without inventing identities or losing rows; restart is idempotent", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-schema3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "monitor.sqlite");
  const db = new DatabaseSync(file);
  db.exec(fixture);
  const before = snapshot(db);
  const incidents = db
    .prepare("SELECT * FROM incidents")
    .all()
    .map(({ monitoringGap, ...row }) => row);
  const generations = db.prepare("SELECT * FROM check_generations").all();
  db.close();
  for (let i = 0; i < 3; i++) {
    const store = new Configuration(file, ChecksSchema.parse({}));
    const monitor = new Monitor(store.runtime(), store.db, null, 1050);
    assert.equal(
      store.db.prepare("PRAGMA user_version").get()?.user_version,
      3,
    );
    assert.deepEqual(snapshot(store.db), before);
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM incidents")
        .all()
        .map(({ monitoringGap, ...row }) => row),
      incidents,
    );
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      "ok",
    );
    assert.deepEqual(
      store.db
        .prepare(
          "SELECT checkId,generation,fingerprint,startedAt,endedAt FROM check_generations",
        )
        .all(),
      generations,
    );
    for (const generation of [1, 2]) {
      const historical = monitor.historyFor(
        "historical",
        generation,
        1050,
        true,
      )!;
      assert.equal(historical.metadataStatus, "legacy-unavailable");
      assert.equal(historical.targetMetadata, null);
    }
    store.db.close();
  }
});

test("schema 3 late migration failure rolls back columns/version/rows and can safely retry; future schema is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(fixture);
  const before = snapshot(db);
  const exec = db.exec.bind(db);
  db.exec = (sql) => {
    if (sql.includes("supersededReason")) {
      exec("ALTER TABLE check_generations ADD COLUMN targetMetadata TEXT");
      throw Error("injected disk/DDL failure");
    }
    return exec(sql);
  };
  assert.throws(() => migrateMonitor(db), /injected/);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert(
    !db
      .prepare("PRAGMA table_info(check_generations)")
      .all()
      .some((row) => row.name === "targetMetadata"),
  );
  assert.deepEqual(snapshot(db), before);
  db.exec = exec;
  migrateMonitor(db);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 3);
  db.close();
  const future = new DatabaseSync(":memory:");
  future.exec("PRAGMA user_version=4");
  assert.throws(() => new Monitor(seed, future, null), /newer/);
  assert.equal(
    future.prepare("SELECT count(*) n FROM sqlite_schema").get()?.n,
    0,
  );
  future.close();
});
