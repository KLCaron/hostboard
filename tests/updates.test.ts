import { updateCounts } from "../src/update-types.js";
// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { generateKeyPair, createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { Monitor } from "../server/monitor.js";
import { Configuration } from "../server/settings.js";
import { ChecksSchema } from "../server/check-config.js";
import { authorization, type AdminConfig } from "../server/admin.js";
import {
  SnapshotSchema,
  UpdateConfigSchema,
  Updates,
  updatesAPI,
} from "../server/updates.js";
import type { ManagedServer } from "../src/server-types.js";
import { updateSample } from "./update-fixture.js";

function fixture(t: test.TestContext) {
  const store = new Configuration(":memory:", ChecksSchema.parse({}));
  const monitor = new Monitor(store.runtime(), store.db, null);
  t.after(() => monitor.stop());
  let now = Date.now() / 1000;
  const records: ManagedServer[] = [
    "host",
    "other",
    "archived",
    "disabled",
  ].map((id) => ({
    id,
    name: id,
    url: "http://127.0.0.1:19999",
    node: id,
    guid: "guid-" + id,
    enabled: id !== "disabled",
    archived: id === "archived",
    groupId: null,
    discovery: null,
    lastSeen: null,
  }));
  const config = UpdateConfigSchema.parse({
    hosts: records.map((h) => ({
      hostId: h.id,
      nodeGuid: h.guid,
      address: "127.0.0.1",
    })),
  });
  let value: unknown = updateSample("host", now),
    fail = false,
    calls = 0;
  const provider = {
    read: async (id: string) => {
      calls++;
      if (fail) throw Error("secret credential");
      return id === "host" ? value : updateSample(id, now);
    },
  };
  const updates = new Updates(
    store,
    () => records,
    config,
    provider,
    () => now,
  );
  t.after(() => {
    updates.stop();
    store.db.close();
  });
  return {
    store,
    records,
    updates,
    provider,
    config,
    get now() {
      return now;
    },
    advance: (seconds: number) => {
      now += seconds;
    },
    set: (s: unknown) => {
      value = s;
    },
    fail: () => {
      fail = true;
    },
    get calls() {
      return calls;
    },
  };
}
test("snapshots validate zero, pending, stale, unsupported and partial results without guessing security", () => {
  const s = updateSample();
  assert(SnapshotSchema.safeParse(s).success);
  s.packages.packages = [];
  s.packages.rebootRequired = false;
  assert(SnapshotSchema.safeParse(s).success);
  s.packages.state = "unsupported";
  s.packages.checkedAt = null;
  s.packages.metadataAt = null;
  assert(SnapshotSchema.safeParse(s).success);
  s.docker.state = "unavailable";
  s.docker.services[0].state = "unavailable";
  s.docker.services[0].checkedAt = null;
  assert(SnapshotSchema.safeParse(s).success);
  assert(
    !SnapshotSchema.safeParse({ ...s, collectedAt: Date.now() / 1000 + 1000 })
      .success,
  );
  assert(!SnapshotSchema.safeParse({ ...s, command: "apt upgrade" }).success);
  const wrong = updateSample();
  wrong.docker.services[0].state = "current";
  assert(!SnapshotSchema.safeParse(wrong).success);
  assert(
    !UpdateConfigSchema.safeParse({
      hosts: [{ hostId: "host", nodeGuid: "guid", address: "example.com" }],
    }).success,
  );
  assert(
    !UpdateConfigSchema.safeParse({
      hosts: [{ hostId: "host", nodeGuid: "guid", address: "8.8.8.8" }],
    }).success,
  );
});
test("latest results persist across monitor restarts; metadata and check age become stale", async (t) => {
  const f = fixture(t);
  assert(await f.updates.refresh("host"));
  assert.equal(f.updates.view()[0].snapshot!.packages.packages.length, 2);
  const restarted = new Updates(
    f.store,
    () => f.records,
    f.config,
    f.provider,
    () => f.now,
  );
  assert.equal(restarted.view()[0].snapshot!.packages.rebootRequired, true);
  assert.equal(
    f.store.db.prepare("PRAGMA user_version").get()!.user_version,
    4,
  );
  f.advance(86401);
  assert.equal(restarted.view()[0].snapshot!.packages.state, "stale");
  assert.equal(restarted.view()[0].snapshot!.docker.state, "stale");
  restarted.stop();
});
test("failure keeps last observation and last success, is visibly stale, isolated and sanitized", async (t) => {
  const f = fixture(t);
  await f.updates.refresh("host");
  const old = f.updates.view()[0].packageLastSuccessAt;
  f.advance(61);
  f.fail();
  assert.equal(await f.updates.refresh("host"), false);
  const h = f.updates.view()[0];
  assert.equal(h.packageLastSuccessAt, old);
  assert.equal(h.snapshot!.packages.state, "stale");
  assert(!h.error!.includes("secret"));
  assert.equal(await f.updates.refresh("other"), false);
  assert.equal(f.updates.view()[1].snapshot, null);
});
test("partial category and registry results remain available, with last successful times retained", async (t) => {
  const f = fixture(t);
  await f.updates.refresh("host");
  const old = f.updates.view()[0];
  f.advance(61);
  const s = updateSample("host");
  s.docker.state = "unavailable";
  s.docker.services[0].state = "unavailable";
  s.docker.services[0].upstreamConfig = null;
  s.docker.services[0].checkedAt = null;
  f.set(s);
  assert(await f.updates.refresh("host"));
  const h = f.updates.view()[0];
  assert.equal(h.snapshot!.packages.state, "ok");
  assert.equal(h.snapshot!.docker.state, "unavailable");
  assert.equal(h.dockerLastSuccessAt, old.dockerLastSuccessAt);
  assert.equal(
    h.snapshot!.docker.services[0].checkedAt,
    old.snapshot!.docker.services[0].checkedAt,
  );
});
test("archived/disabled/unknown hosts cannot be refreshed, and throttling survives restart", async (t) => {
  const f = fixture(t);
  for (const id of ["archived", "disabled", "unknown"])
    assert.equal(await f.updates.refresh(id), false);
  assert.equal(f.calls, 0);
  await f.updates.refresh("host");
  const count = f.calls;
  await f.updates.refresh("host");
  assert.equal(f.calls, count);
  const restarted = new Updates(
    f.store,
    () => f.records,
    f.config,
    f.provider,
    () => f.now,
  );
  await restarted.refresh("host");
  assert.equal(f.calls, count);
  restarted.stop();
  f.records[0].archived = true;
  f.advance(21601);
  await f.updates.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls, count + 1); // only other
});
test("cross-host, unverified and replaced identities cannot overwrite registered observations", async (t) => {
  const f = fixture(t);
  f.set(updateSample("other"));
  assert.equal(await f.updates.refresh("host"), false);
  assert.equal(f.updates.view()[0].snapshot, null);
  f.advance(61);
  f.set(updateSample());
  f.records[0].guid = null;
  assert.equal(await f.updates.refresh("host"), false);
  f.advance(61);
  f.records[0].guid = "replacement";
  assert.equal(await f.updates.refresh("host"), false);
});
test("archiving during a read discards the result and concurrent refreshes share capacity", async (t) => {
  const f = fixture(t);
  let complete!: (s: unknown) => void;
  const u = new Updates(
    f.store,
    () => f.records,
    { ...f.config, hosts: [f.config.hosts[0]] },
    { read: () => new Promise((r) => (complete = r)) },
  );
  const pending = u.refresh("host");
  assert.equal(await u.refresh("host"), false);
  f.records[0].archived = true;
  await u.tick();
  complete(updateSample());
  assert.equal(await pending, false);
  assert.equal(u.view()[0].snapshot, null);
  u.stop();
});
test("API requires signed administrator identity, same-origin JSON refresh and has no execution endpoints", async (t) => {
  const f = fixture(t),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test";
  const admin: AdminConfig = {
    issuer: "https://fixture.cloudflareaccess.com",
    audience: "test",
    emails: ["admin@example.com"],
    origin: url,
    targets: [],
  };
  const auth = authorization(admin, createLocalJWKSet({ keys: [jwk] }));
  app.use("/api/admin/updates", updatesAPI(f.updates, admin, auth));
  const token = await new SignJWT({ email: "admin@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(admin.issuer)
    .setAudience("test")
    .setSubject("admin")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
  const endpoint = url + "/api/admin/updates";
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal(
    (
      await fetch(endpoint, {
        headers: { "Cf-Access-Jwt-Assertion": "forged" },
      })
    ).status,
    403,
  );
  const headers = {
    "Cf-Access-Jwt-Assertion": token,
    Origin: url,
    "X-Hostboard-Request": "1",
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(endpoint, { headers })).status, 200);
  assert.equal(
    (
      await fetch(endpoint + "/host/refresh", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint + "/host/refresh", {
        method: "POST",
        headers,
        body: '{"command":"docker pull"}',
      })
    ).status,
    400,
  );
  const refresh = await fetch(endpoint + "/host/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).host.hostId, "host");
  assert.equal(
    (
      await fetch(endpoint + "/archived/refresh", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
    409,
  );
  for (const action of ["install", "upgrade", "pull", "restart", "exec"])
    assert.equal(
      (
        await fetch(endpoint + "/host/" + action, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
});

test("local administrator sessions protect update reads and refresh CSRF boundaries", async (t) => {
  const { hash } = await import("argon2");
  const { randomBytes } = await import("node:crypto");
  const { localAuthentication } = await import("../server/local-auth.js");
  const f = fixture(t),
    app = express(),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin: AdminConfig = {
    mode: "local",
    origin: url,
    username: "operator",
    passwordHash: await hash("fixture-long-password", {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    }),
    sessionSecret: randomBytes(32).toString("hex"),
    trustedProxies: [],
    targets: [],
  };
  const stop = localAuthentication(app, admin);
  app.use("/api/admin/updates", updatesAPI(f.updates, admin));
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
  });
  const endpoint = url + "/api/admin/updates";
  assert.equal((await fetch(endpoint)).status, 401);
  const loginPage = await fetch(url + "/auth/login");
  const csrf = (await loginPage.text()).match(
    /name="csrf" value="([a-f0-9]+)"/,
  )![1];
  const initialCookie = loginPage.headers.get("set-cookie")!.split(";")[0];
  const login = await fetch(url + "/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: {
      Origin: url,
      Cookie: initialCookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "operator",
      password: "fixture-long-password",
      csrf,
    }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await fetch(endpoint, { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (
      await fetch(endpoint + "/host/refresh", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: url,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint + "/host/refresh", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: url,
          "Content-Type": "application/json",
          "X-Hostboard-Request": "1",
        },
        body: "{}",
      })
    ).status,
    200,
  );
});

test("on-disk observations survive SQLite close/reopen and previous schema-4 monitoring remains compatible", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "hb-updates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "monitor.sqlite");
  const seed = ChecksSchema.parse({});
  let store = new Configuration(file, seed),
    monitor = new Monitor(store.runtime(), store.db, null);
  const host: ManagedServer = {
    id: "host",
    name: "Original host",
    url: "http://127.0.0.1:19999",
    node: "host",
    guid: "guid-host",
    enabled: true,
    archived: false,
    groupId: null,
    discovery: null,
    lastSeen: null,
  };
  const config = UpdateConfigSchema.parse({
    hosts: [{ hostId: "host", nodeGuid: "guid-host", address: "127.0.0.1" }],
  });
  const provider = { read: async () => updateSample() };
  const updates = new Updates(store, () => [host], config, provider);
  assert(await updates.refresh("host"));
  const first = updates.view()[0];
  updates.stop();
  monitor.stop();
  store.db.close();
  // Existing monitor code knows only schema 4 and ignores the additive table.
  store = new Configuration(file, seed);
  monitor = new Monitor(store.runtime(), store.db, null);
  host.name = "Renamed host";
  const reopened = new Updates(store, () => [host], config, provider);
  assert.equal(reopened.view()[0].name, "Renamed host");
  assert.deepEqual(reopened.view()[0].snapshot, first.snapshot);
  assert.equal(store.db.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
  reopened.stop();
  monitor.stop();
  store.db.close();
});

test("SSH snapshot transport fixes account, command, destination and pinned key policy, and bounds/cancels reads", async (t) => {
  const { SSHUpdateProvider } = await import("../server/updates.js");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "hb-update-ssh-")),
    previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PATH = dir + ":" + previousPath;
  const argsFile = path.join(dir, "args.json"),
    script = path.join(dir, "ssh");
  const write = (body: string) =>
    writeFileSync(script, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const config = UpdateConfigSchema.parse({
    hosts: [
      {
        hostId: "host",
        nodeGuid: "guid-host",
        address: "127.0.0.1",
        port: 2222,
      },
    ],
  });
  const provider = new SSHUpdateProvider(config, dir);
  write(
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(updateSample()))});`,
  );
  assert(
    SnapshotSchema.safeParse(
      await provider.read("host", new AbortController().signal),
    ).success,
  );
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.deepEqual(
    args.slice(-6),
    [
      "-p",
      "2222",
      "-l",
      "hostboard-updates",
      "127.0.0.1",
      "hostboard-updates-v1",
    ].slice(-6),
  );
  for (const option of [
    "StrictHostKeyChecking=yes",
    "IdentityAgent=none",
    "ClearAllForwardings=yes",
    "ProxyCommand=none",
    "PermitLocalCommand=no",
  ])
    assert(args.includes(option));
  assert(args.includes("UserKnownHostsFile=" + path.join(dir, "known_hosts")));
  assert(args.includes(path.join(dir, "id_ed25519")));
  await assert.rejects(
    provider.read("unregistered", new AbortController().signal),
  );
  write('process.stdout.write("x".repeat(4000001));');
  await assert.rejects(
    provider.read("host", new AbortController().signal),
    /size/,
  );
  write("setInterval(()=>{},1000);");
  const controller = new AbortController();
  const pending = provider.read("host", controller.signal);
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, /cancelled/);
});

test("fleet summaries keep exact counts without loading or sending full inventories", async (t) => {
  const f = fixture(t);
  await f.updates.refresh("host");
  const summary = f.updates.view(false)[0],
    detail = f.updates.view(true, "host")[0];
  assert.equal(summary.detailsIncluded, false);
  assert.equal(summary.counts!.total, 2);
  assert.equal(summary.counts!.ordinary, 1);
  assert.equal(summary.counts!.security, 1);
  assert.equal(summary.counts!.images, 1);
  assert.deepEqual(summary.snapshot!.packages.packages, []);
  assert.deepEqual(summary.snapshot!.docker.services, []);
  assert.equal(detail.snapshot!.packages.packages[0].name, "libexample");
  // Deliberately corrupt only the large detail payload. The overview must not
  // read or parse it, proving summary isolation rather than just a small result.
  f.store.db
    .prepare(
      "UPDATE update_snapshots SET snapshot='invalid-json' WHERE hostId='host'",
    )
    .run();
  assert.equal(f.updates.view(false)[0].counts!.total, 2);
});

test("Docker summary counts unique Compose services separately from container instances and does not infer version ordering", () => {
  const snapshot = updateSample();
  snapshot.docker.services.push({
    ...snapshot.docker.services[0],
    container: "d".repeat(64),
  });
  snapshot.docker.services.push({
    ...snapshot.docker.services[0],
    container: "e".repeat(64),
    service: "second",
  });
  snapshot.docker.services.push({
    ...snapshot.docker.services[0],
    container: "f".repeat(64),
    project: "another",
  });
  assert.equal(snapshot.docker.services.length, 4);
  assert.equal(updateCounts(snapshot).images, 3);
});

test("snapshot validates platform-manifest comparisons without treating index IDs as config digests", () => {
  const s = updateSample(),
    service = s.docker.services[0];
  service.deployedImageId = "sha256:" + "d".repeat(64);
  service.deployedConfig = null;
  service.deployedManifest = service.upstreamDigest;
  service.state = "current";
  assert(SnapshotSchema.safeParse(s).success);
  service.state = "update";
  assert(!SnapshotSchema.safeParse(s).success);
  service.deployedManifest = "sha256:" + "e".repeat(64);
  assert(SnapshotSchema.safeParse(s).success);
  service.deployedManifest = null;
  assert(!SnapshotSchema.safeParse(s).success);
});

test("existing compact overviews gain bounded previews at restart without collection or schema change", async (t) => {
  const f = fixture(t);
  await f.updates.refresh("host");
  const row = f.store.db
    .prepare("SELECT overview FROM update_snapshots WHERE hostId='host'")
    .get()!;
  const old = JSON.parse(row.overview as string);
  delete old.preview;
  f.store.db
    .prepare("UPDATE update_snapshots SET overview=? WHERE hostId='host'")
    .run(JSON.stringify(old));
  const calls = f.calls;
  const restarted = new Updates(
    f.store,
    () => f.records,
    f.config,
    f.provider,
    () => f.now,
  );
  t.after(() => restarted.stop());
  const summary = restarted.view(false)[0];
  assert.equal(f.calls, calls);
  assert.deepEqual(summary.preview!.packages[0], {
    name: "libexample",
    security: true,
  });
  assert.equal(summary.preview!.services.length, 1);
  assert.deepEqual(summary.snapshot!.packages.packages, []);
  assert.equal(
    f.store.db.prepare("PRAGMA user_version").get()!.user_version,
    4,
  );
});

test("a damaged legacy inventory cannot stop preview backfill or other monitoring", async (t) => {
  const f = fixture(t);
  await f.updates.refresh("host");
  await f.updates.refresh("other");
  for (const id of ["host", "other"]) {
    const row = f.store.db
      .prepare("SELECT overview FROM update_snapshots WHERE hostId=?")
      .get(id)!;
    const old = JSON.parse(row.overview as string);
    delete old.preview;
    f.store.db
      .prepare("UPDATE update_snapshots SET overview=? WHERE hostId=?")
      .run(JSON.stringify(old), id);
  }
  f.store.db
    .prepare(
      "UPDATE update_snapshots SET snapshot='invalid-json' WHERE hostId='host'",
    )
    .run();
  const restarted = new Updates(
    f.store,
    () => f.records,
    f.config,
    f.provider,
    () => f.now,
  );
  t.after(() => restarted.stop());
  assert.equal(restarted.view(false)[0].counts!.total, 2);
  assert.equal(restarted.view(false)[1].preview!.packages.length, 2);
});
