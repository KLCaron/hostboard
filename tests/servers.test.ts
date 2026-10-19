import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverFixture } from "./server-fixture.js";
import { Agent, agentDiagnostic } from "../server/netdata.js";
import { AgentTrust, AgentPolicySchema } from "../server/agent-policy.js";
import { Configuration } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import { ChecksSchema } from "../server/check-config.js";
import { Servers } from "../server/servers.js";
import { migrateMonitor } from "../server/monitor-schema.js";
import { TargetPolicy } from "../server/targets.js";

test("server onboarding selects parent/child GUIDs, prevents duplicates, persists and preserves identities through lifecycle/group edits", async (t) => {
  const f = await serverFixture();
  t.after(f.close);
  const connection = { name: "My machine", url: f.url };
  let result = await f.call("/test", { connection });
  assert.equal(result.status, 200);
  assert.equal(result.body.nodes.length, 2);
  assert.equal(result.body.testId, undefined);
  f.resetLimit();
  result = await f.call("/test", {
    connection: { ...connection, node: "child-machine-guid" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.discovery.hostname, "fixture-child");
  assert.equal(result.body.discovery.cpuModel, "Example child CPU");
  assert.equal(result.body.discovery.memoryBytes, 24429363200);
  assert.deepEqual(result.body.discovery.interfaces, ["eth0"]);
  assert.deepEqual(result.body.discovery.sensors, []);
  const testId = result.body.testId;
  result = await f.call("", {
    revision: f.store.revision(),
    connection: { ...connection, node: "child-machine-guid" },
    enabled: true,
    groupId: null,
  });
  assert.equal(result.status, 400);
  result = await f.call("", {
    revision: f.store.revision(),
    connection: { ...connection, node: "child-machine-guid" },
    enabled: true,
    groupId: null,
    testId,
  });
  assert.equal(result.status, 201);
  const id = result.body.id;
  await f.registry.fleet();
  assert.equal(f.registry.records()[0].guid, "child-machine-guid");
  f.resetLimit();
  assert.equal(
    (
      await f.call("/test", {
        connection: { ...connection, node: "child-machine-guid" },
      })
    ).status,
    422,
  );
  const revision = f.store.revision();
  const renamed = {
    revision,
    connection: { ...connection, name: "Renamed", node: "child-machine-guid" },
    enabled: false,
    groupId: null,
  };
  const edits = await Promise.all([
    f.call("/" + id, renamed, "PUT"),
    f.call("/" + id, renamed, "PUT"),
  ]);
  assert.deepEqual(edits.map((e) => e.status).sort(), [200, 409]);
  const calls = f.calls;
  await f.registry.current(id);
  assert.equal(f.calls, calls);
  assert.equal(f.registry.agent(id), undefined);
  assert.equal(
    (
      await f.call("/groups", {
        revision: f.store.revision(),
        name: "Production",
      })
    ).status,
    200,
  );
  const groupId = f.registry.groups()[0].id;
  assert.equal(
    (
      await f.call(
        "/" + id,
        { ...renamed, revision: f.store.revision(), enabled: true, groupId },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal((await f.registry.current(id)).groupName, "Production");
  assert.equal(
    (
      await f.call(`/groups/${groupId}/remove`, {
        revision: f.store.revision(),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("/groups", {
        revision: f.store.revision(),
        name: "Home lab",
        id: groupId,
      })
    ).status,
    200,
  );
  assert.equal((await f.registry.current(id)).groupName, "Home lab");
  assert.equal(
    (await f.call("/" + id + "/archive", { revision: f.store.revision() }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.call("/" + id + "/archive", {
        revision: f.store.revision(),
        confirm: "ARCHIVE",
      })
    ).status,
    200,
  );
  const archivedCalls = f.calls;
  const archived = await f.registry.current(id);
  assert.equal(archived.archived, true);
  assert.match(archived.error!, /monitoring has stopped/);
  assert.equal(f.calls, archivedCalls);
  const reopened = new Configuration(f.filename, ChecksSchema.parse({}));
  const monitor = new Monitor(reopened.runtime(), reopened.db, null);
  const registry = new Servers(reopened, f.trust, [
    { id: "extraneous", name: "Must not import", url: f.url, node: "other" },
  ]);
  assert.equal(registry.records().length, 1);
  assert.equal(registry.records()[0].id, id);
  assert.equal(registry.records()[0].name, "Renamed");
  assert.equal(registry.records()[0].archived, true);
  assert.equal(registry.groups()[0].name, "Home lab");
  monitor.stop();
  reopened.db.close();
  assert.equal(
    (
      await f.call(
        "/" + id,
        { ...renamed, revision: f.store.revision(), enabled: true },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(`/groups/${groupId}/remove`, {
        revision: f.store.revision(),
      })
    ).status,
    200,
  );
  // Connection edits preserve GUID and require a fresh successful test, even on an approved endpoint.
  f.resetLimit();
  const wrong = await f.call("/test", {
    id,
    connection: { ...connection, node: "parent-machine-guid" },
  });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.diagnostic, "identity");
  assert.equal(
    (
      await f.call(
        "/" + id,
        {
          ...renamed,
          revision: f.store.revision(),
          connection: { ...connection, url: "http://127.0.0.1:9999" },
        },
        "PUT",
      )
    ).status,
    400,
  );
});

test("Agent-management APIs require signed administrator identity and same-origin JSON; cannot expose credentials or become an arbitrary proxy", async (t) => {
  const f = await serverFixture();
  t.after(f.close);
  assert.equal(
    (
      await f.call("", undefined, "GET", {
        "Cf-Access-Jwt-Assertion": "forged",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/test",
        { connection: { name: "No", url: f.url } },
        "POST",
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/test",
        { connection: { name: "No", url: f.url } },
        "POST",
        { "X-Hostboard-Request": "" },
      )
    ).status,
    403,
  );
  const initial = f.calls;
  for (const url of [
    "http://169.254.169.254",
    "http://192.168.1.254:19999",
    "https://127.0.0.1:" + new URL(f.url).port,
  ]) {
    f.resetLimit();
    const r = await f.call("/test", { connection: { name: "Denied", url } });
    assert.equal(r.status, 422);
    assert.equal(r.body.diagnostic, "policy");
  }
  assert.equal(f.calls, initial);
  for (const url of [
    f.url + "/api/v3/function",
    f.url + "?path=/secret",
    "file:///etc/passwd",
    f.url.replace("http://", "http://user:secret@"),
  ]) {
    f.resetLimit();
    assert.equal(
      (await f.call("/test", { connection: { name: "Denied", url } })).status,
      400,
    );
  }
  assert.equal(
    (
      await f.call("/test", {
        connection: { name: "No", url: f.url, tokenEnv: "SECRET" },
      })
    ).status,
    400,
  );
  const publicData = JSON.stringify((await f.call("")).body);
  assert(!publicData.includes("tokenEnv"));
  assert(!publicData.includes("addresses"));
});

test("local authentication also protects server APIs on direct LAN and rejects forged Cloudflare headers", async (t) => {
  const f = await serverFixture("local");
  t.after(f.close);
  assert.equal((await f.call("")).status, 401);
  const login = await fetch(f.origin + "/auth/login");
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const csrf = (await login.text()).match(
    /name="csrf" value="([a-f0-9]+)"/,
  )![1];
  const response = await fetch(f.origin + "/auth/login", {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Origin: f.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "operator",
      password: "a-long-fixture-password",
      csrf,
    }),
  });
  assert.equal(response.status, 303);
  const session = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await f.call("", undefined, "GET", { Cookie: session })).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/test",
        { connection: { name: "Local", url: f.url } },
        "POST",
        { Cookie: session },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/groups",
        { revision: f.store.revision(), name: "No CSRF" },
        "POST",
        { Cookie: session, Origin: "http://evil.test" },
      )
    ).status,
    403,
  );
});

test("discovery is cached, handles missing optional metadata/partial APIs, large catalogs, changed identities and invalid responses", async (t) => {
  const f = await serverFixture("cloudflare", true);
  t.after(f.close);
  await f.registry.fleet();
  assert.equal(f.registry.records()[0].id, "existing-0");
  assert.equal(f.registry.records()[0].guid, "parent-machine-guid");
  const a = f.registry.agent("existing-0")!;
  const initial = f.calls;
  await a.discover();
  await a.discover();
  assert.equal(f.calls, initial);
  delete f.metadata.nodes[0].hw;
  delete f.metadata.nodes[0].os;
  delete f.metadata.nodes[0].labels;
  a.invalidate();
  const missing = await a.discover();
  assert.equal(missing.cpuModel, null);
  assert.equal(missing.memoryBytes, null);
  assert.equal(missing.os, null);
  f.setFailure(503);
  a.invalidate();
  const partial = await a.discover();
  assert(partial.contexts.includes("system.cpu"));
  assert(partial.warnings.length);
  assert.equal(partial.chartCount, 0);
  f.setFailure(200, 503);
  a.invalidate();
  const fallback = await a.discover();
  assert(fallback.contexts.includes("disk.space"));
  assert(fallback.warnings.length);
  f.setFailure(503, 503);
  a.invalidate();
  await assert.rejects(a.discover());
  f.setFailure();
  f.setMalformed(true);
  a.invalidate();
  await assert.rejects(a.discover());
  f.setMalformed(false);
  for (let i = 0; i < 5000; i++)
    f.metadata.charts["custom." + i] = {
      id: "custom." + i,
      context: "custom." + i,
      family: "custom",
      units: "units",
    };
  a.invalidate();
  assert((await a.discover()).chartCount > 5000);
  delete f.metadata.charts["system.cpu"];
  a.invalidate();
  assert(!(await a.discover()).contexts.includes("system.cpu"));
  f.metadata.nodes[0].mg = "different-machine";
  a.invalidate();
  const changed = await a.current();
  assert.equal(changed.status, "offline");
  assert.match(changed.error!, /identity/);
  assert.equal(f.registry.records()[0].guid, "parent-machine-guid");
  // An unpinned static registration visible through the Parent is already reserved.
  f.resetLimit();
  assert.equal(
    (
      await f.call("/test", {
        connection: {
          name: "Duplicate child",
          url: f.url,
          node: "child-machine-guid",
        },
      })
    ).status,
    422,
  );
});

test("destination checks reject DNS rebinding, mixed answers, metadata, translated IPv6 and redirects; diagnostic errors are sanitized", async (t) => {
  const policy = new TargetPolicy(
    [{ host: "agent.example", port: 19999, addresses: ["10.0.0.2"] }],
    async () => [{ address: "169.254.169.254", family: 4 }] as any,
  );
  const check = ChecksSchema.parse({
    checks: [
      {
        id: "agent",
        name: "Agent",
        hostId: "agent",
        type: "http",
        url: "http://agent.example:19999",
      },
    ],
  }).checks[0];
  await assert.rejects(policy.address(check), /not permitted/);
  for (const address of [
    "169.254.169.254",
    "100.100.100.200",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "fd00:ec2::254",
  ]) {
    const url = `http://${address.includes(":") ? "[" + address + "]" : address}:19999`;
    await assert.rejects(
      new AgentTrust([{ url, addresses: [address] }]).destination(url),
      /not permitted/,
    );
  }
  const f = await serverFixture();
  t.after(f.close);
  f.setFailure(200, 200, 302);
  const result = await f.call("/test", {
    connection: { name: "Redirect", url: f.url },
  });
  assert.equal(result.body.diagnostic, "redirect");
  assert.equal(f.calls, 1);
  assert.equal(agentDiagnostic({ code: "ECONNREFUSED" }).code, "refused");
  assert.equal(agentDiagnostic({ code: "ENOTFOUND" }).code, "dns");
  assert.equal(agentDiagnostic({ code: "CERT_HAS_EXPIRED" }).code, "tls");
  assert.equal(agentDiagnostic({ name: "TimeoutError" }).code, "timeout");
  const secret = agentDiagnostic(Error("Bearer top-secret transport failure"));
  assert(!secret.message.includes("top-secret"));
  assert(
    !AgentPolicySchema.safeParse({
      endpoints: [{ url: "http://agent/path", addresses: ["10.0.0.2"] }],
    }).success,
  );
});

test("actual schema-3 fixture migrates transactionally without changing historical/log associations, imports once and safely retries failed DDL", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-schema4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "monitor.sqlite"),
    old = new DatabaseSync(filename);
  old.exec(
    readFileSync(
      new URL("./fixtures/monitor-schema3.sql", import.meta.url),
      "utf8",
    ),
  );
  const tables = [
    "samples",
    "incidents",
    "notifications",
    "service_config",
    "app_settings",
    "check_generations",
    "log_mappings",
  ];
  const snapshot = (db: DatabaseSync) =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  const before = snapshot(old);
  const exec = old.exec.bind(old);
  old.exec = (sql) => {
    if (sql.includes("CREATE TABLE server_groups")) {
      exec("CREATE TABLE server_groups(id TEXT)");
      throw Error("Injected schema4 failure");
    }
    return exec(sql);
  };
  assert.throws(() => migrateMonitor(old), /Injected/);
  assert.equal(old.prepare("PRAGMA user_version").get()!.user_version, 3);
  assert(
    !old
      .prepare("SELECT name FROM sqlite_schema WHERE name='server_groups'")
      .get(),
  );
  assert.deepEqual(snapshot(old), before);
  old.exec = exec;
  old.close();
  const store = new Configuration(filename, ChecksSchema.parse({}));
  migrateMonitor(store.db);
  assert.deepEqual(snapshot(store.db), before);
  const monitor = new Monitor(store.runtime(), store.db, null, 1050);
  // Restart marks a real observation gap on the active incident, preserving its identity.
  for (const row of before.incidents as any[])
    if (!row.endedAt) row.monitoringGap = 1;
  assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 4);
  assert.deepEqual(snapshot(store.db), before);
  const seed = [
    {
      id: "new-host",
      name: "Existing server",
      node: "fixture-server",
      url: "http://127.0.0.1:19999",
    },
  ];
  const registry = new Servers(
    store,
    new AgentTrust([{ url: seed[0].url, addresses: ["127.0.0.1"] }]),
    seed,
  );
  assert.equal(registry.records()[0].id, "new-host");
  assert.deepEqual(snapshot(store.db), before);
  monitor.stop();
  store.db.close();
  const reopened = new Configuration(filename, ChecksSchema.parse({})),
    again = new Monitor(reopened.runtime(), reopened.db, null, 1050);
  assert.equal(
    new Servers(reopened, new AgentTrust([]), []).records()[0].id,
    "new-host",
  );
  assert.deepEqual(snapshot(reopened.db), before);
  again.stop();
  reopened.db.close();
});

test("slow Agent refreshes return independently and disabling cancels in-flight work", async (t) => {
  const f = await serverFixture("cloudflare", true);
  t.after(f.close);
  f.setDelay(1700);
  const started = performance.now(),
    fleet = await f.registry.fleet();
  assert(performance.now() - started < 2000);
  assert(fleet.every((h) => h.status === "stale"));
  assert(fleet.every((h) => /refresh/.test(h.error || "")));
  const r = f.registry.records()[0];
  const response = await f.call(
    "/" + r.id,
    {
      revision: f.store.revision(),
      connection: { name: r.name, url: r.url, node: r.node },
      enabled: false,
      groupId: null,
    },
    "PUT",
  );
  assert.equal(response.status, 200);
  const disabled = await f.registry.current(r.id);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status, "offline");
  const other = f.registry.records()[1];
  assert.equal(
    (
      await f.call(
        "/" + other.id,
        {
          revision: f.store.revision(),
          connection: { name: other.name, url: other.url, node: other.node },
          enabled: false,
          groupId: null,
        },
        "PUT",
      )
    ).status,
    200,
  );
  const calls = f.calls;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.calls, calls);
});

test("successful capability refreshes and private token handling retain the original GUID", async (t) => {
  const f = await serverFixture("cloudflare", true);
  t.after(f.close);
  await f.registry.fleet();
  const r = f.registry.records()[0];
  f.metadata.nodes[0].labels._system_cpu_model = "Updated reported CPU";
  f.resetLimit();
  const result = await f.call("/test", {
    id: r.id,
    connection: { name: r.name, url: r.url, node: r.guid },
  });
  assert.equal(result.status, 200);
  assert.equal(
    (
      await f.call(
        "/" + r.id,
        {
          revision: f.store.revision(),
          connection: { name: r.name, url: r.url, node: r.guid },
          enabled: true,
          groupId: null,
          testId: result.body.testId,
        },
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    f.registry.records()[0].discovery?.cpuModel,
    "Updated reported CPU",
  );
  f.resetLimit();
  const add = await f.call("/test", {
    connection: { name: "Duplicate", url: f.url, node: r.guid },
  });
  assert.equal(add.status, 422);
  // Tokens are only ever obtained from private policy, with no path/redirect proxy.
  process.env.HB_FIXTURE_TOKEN = "private-test-token";
  const trust = new AgentTrust([
    { url: f.url, addresses: ["127.0.0.1"], tokenEnv: "HB_FIXTURE_TOKEN" },
  ]);
  assert.equal((await trust.destination(f.url)).token, "private-test-token");
  delete process.env.HB_FIXTURE_TOKEN;
  await assert.rejects(trust.destination(f.url), /authentication/);
});
