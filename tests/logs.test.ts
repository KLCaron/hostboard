// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { generateKeyPair, SignJWT } from "jose";
import { hash } from "argon2";
import { randomBytes } from "node:crypto";
import { Configuration } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import { ChecksSchema } from "../server/check-config.js";
import {
  authorization,
  LocalSchema,
  type AdminConfig,
} from "../server/admin.js";
import { localAuthentication } from "../server/local-auth.js";
import { logsAPI, LogQuerySchema, type LogProvider } from "../server/logs.js";
import { incidentLogWindow } from "../src/log-types.js";
const seed = ChecksSchema.parse({
  checks: [
    {
      id: "web",
      hostId: "host",
      name: "Web",
      type: "http",
      url: "http://127.0.0.1:8000",
      failureThreshold: 1,
    },
  ],
});
const q = {
  source: "web",
  after: "2026-01-01T00:00:00.000Z",
  before: "2026-01-01T00:15:00.000Z",
};
async function fixture(t: test.TestContext, local = false) {
  const store = new Configuration(":memory:", seed),
    monitor = new Monitor(store.runtime(), store.db, null, 1000),
    app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const keys = await generateKeyPair("RS256");
  const config: AdminConfig = local
    ? LocalSchema.parse({
        mode: "local",
        origin: url,
        username: "operator",
        passwordHash: await hash("test-password-long", {
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        }),
        sessionSecret: randomBytes(32).toString("hex"),
        targets: [],
      })
    : {
        issuer: "https://fixture.cloudflareaccess.com",
        audience: "test",
        emails: ["admin@example.com"],
        origin: "https://hostboard.example.com",
        targets: [],
      };
  const stop = local
    ? localAuthentication(app, config as ReturnType<typeof LocalSchema.parse>)
    : () => {};
  let calls = 0,
    aborted = false;
  const provider: LogProvider = {
    sources: async (hostId) => [
      {
        id: "web",
        hostId,
        name: "Web",
        available: true,
        containerId: "a".repeat(64),
      },
    ],
    query: async (_host, query, signal) => {
      calls++;
      if (query.source === "wait")
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("cancelled"));
            },
            { once: true },
          );
        });
      if (query.source !== "web") throw Error("Source is not approved");
      return {
        containerId: "a".repeat(64),
        containerName: "web",
        created: q.after,
        driver: "json-file",
        tty: false,
        entries: [
          {
            time: q.after,
            stream: "stderr",
            text: "<script>unsafe</script>",
            truncated: false,
          },
        ],
        truncated: false,
        nextCursor: null,
        resumeCursor: null,
        scannedBytes: 100,
        notice: "Retained logs only",
        incomplete: false,
      };
    },
  };
  app.use(
    "/api/admin/logs",
    logsAPI(
      store,
      monitor,
      config,
      ["host"],
      provider,
      authorization(config, async () => keys.publicKey),
    ),
  );
  t.after(() => {
    stop();
    server.closeAllConnections();
    server.close();
    monitor.stop();
    store.db.close();
  });
  const token = async (email = "admin@example.com") =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer("https://fixture.cloudflareaccess.com")
      .setAudience("test")
      .sign(keys.privateKey);
  let headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hostboard-Request": "1",
    Origin: config.origin,
  };
  if (local) {
    const page = await fetch(url + "/auth/login"),
      csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)![1],
      cookie = page.headers.get("set-cookie")!.split(";")[0];
    const login = await fetch(url + "/auth/login", {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: url,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "operator",
        password: "test-password-long",
        csrf,
      }),
    });
    assert.equal(login.status, 303);
    headers.Cookie = login.headers.get("set-cookie")!.split(";")[0];
  } else headers["Cf-Access-Jwt-Assertion"] = await token();
  const request = (
    route: string,
    body?: unknown,
    method = "POST",
    override: Record<string, string> = {},
  ) =>
    fetch(url + "/api/admin/logs/" + route, {
      method,
      headers: { ...headers, ...override },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    store,
    monitor,
    request,
    token,
    url,
    headers,
    get calls() {
      return calls;
    },
    get aborted() {
      return aborted;
    },
  };
}
for (const local of [false, true])
  test(`log endpoints enforce ${local ? "local sessions" : "signed Cloudflare allowlist"} administrator authorization and CSRF`, async (t) => {
    const f = await fixture(t, local);
    const anon = await fetch(f.url + "/api/admin/logs/sources/host");
    assert.equal(anon.status, local ? 401 : 403);
    if (!local) {
      for (const token of ["forged", await f.token("viewer@example.com")])
        assert.equal(
          (
            await f.request("query/host", q, "POST", {
              "Cf-Access-Jwt-Assertion": token,
            })
          ).status,
          403,
        );
    }
    assert.equal(
      (
        await f.request("query/host", q, "POST", {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal((await f.request("query/host", q)).status, 200);
    assert.equal(
      (await f.request("sources/host", undefined, "GET")).status,
      200,
    );
    assert.equal(
      (await f.request("query/host", { ...q, source: "other" })).status,
      502,
    );
    assert.equal((await f.request("query/other", q)).status, 404);
    const before = f.calls;
    for (const change of [
      { exec: "sh" },
      { url: "http://daemon" },
      { search: "x".repeat(257) },
      { before: "2026-01-03T00:00:00.000Z" },
      { cursor: { containerId: "../../etc/passwd" } },
    ])
      assert.equal(
        (await f.request("query/host", { ...q, ...change })).status,
        400,
      );
    assert.equal(f.calls, before);
    for (const method of ["DELETE", "PUT", "PATCH", "GET"])
      assert.equal(
        (
          await f.request(
            "query/host",
            method === "GET" ? undefined : q,
            method,
          )
        ).status,
        404,
      );
  });
test("explicit mappings are host/generation scoped, support multiple sources, survive recreation and cannot drift across a service edit", async (t) => {
  const f = await fixture(t),
    context = { hostId: "host", serviceId: "web", generation: 1 };
  assert.deepEqual(
    (await (await f.request("context", context)).json()).sources,
    [],
  );
  assert.equal(
    (await f.request("context", { context, sources: ["web"] }, "PUT")).status,
    200,
  );
  assert.deepEqual(
    (await (await f.request("context", context)).json()).sources,
    ["web"],
  );
  assert.equal(
    (await f.request("context", { context, sources: ["arbitrary"] }, "PUT"))
      .status,
    502,
  );
  f.monitor.record(
    seed.checks[0],
    { ok: false, responseMs: null, reason: "fixture" },
    1001,
  );
  const incident = f.monitor.view(undefined, undefined, false).incidents[0];
  assert(incident);
  assert.deepEqual(
    (
      await (
        await f.request("context", { hostId: "host", incidentId: incident.id })
      ).json()
    ).sources,
    ["web"],
  );
  const updated = ChecksSchema.parse({
    checks: [{ ...seed.checks[0], url: "http://127.0.0.1:8001" }],
  });
  f.monitor.configure(updated, 1002);
  assert.deepEqual(
    (await (await f.request("context", { ...context, generation: 2 })).json())
      .sources,
    [],
  );
  assert.deepEqual(
    (
      await (
        await f.request("context", { hostId: "host", incidentId: incident.id })
      ).json()
    ).sources,
    ["web"],
  );
  assert.equal(
    (await f.request("context", { ...context, hostId: "other" })).status,
    502,
  );
  assert.equal(
    f.store.db.prepare("PRAGMA user_version").get()?.user_version,
    4,
  );
  assert(
    !JSON.stringify(
      f.store.db.prepare("SELECT * FROM log_access_audit").all(),
    ).includes("unsafe"),
  );
});
test("disconnected requests cancel the provider; admission limit bounds live poll queries", async (t) => {
  const f = await fixture(t),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    fetch(f.url + "/api/admin/logs/query/host", {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ ...q, source: "wait" }),
      signal: controller.signal,
    }).catch(() => {}),
  );
  while (f.calls < 4) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await f.request("query/host", q)).status, 429);
  controllers.forEach((c) => c.abort());
  await Promise.all(pending);
  for (let n = 0; n < 100 && !f.aborted; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert(f.aborted);
});
test("incident navigation selects onset plus padding, caps long incidents, and query validation rejects unsafe shapes", () => {
  const window = incidentLogWindow(2000, 2100, 3000);
  assert.equal(Date.parse(window.after) / 1000, 1100);
  assert.equal(Date.parse(window.before) / 1000, 3000);
  const long = incidentLogWindow(2000, 200000, 300000);
  assert.equal(Date.parse(long.before) - Date.parse(long.after), 86400000);
  assert.throws(() =>
    LogQuerySchema.parse({ ...q, source: "../../containers" }),
  );
});
