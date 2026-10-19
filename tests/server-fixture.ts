import express from "express";
import http from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { hash } from "argon2";
import { randomBytes } from "node:crypto";
import { Configuration } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import { authorization, type AdminConfig } from "../server/admin.js";
import { ChecksSchema } from "../server/check-config.js";
import { Servers } from "../server/servers.js";
import { AgentTrust } from "../server/agent-policy.js";
import { configAPI, synchronize } from "../server/config-api.js";
import { localAuthentication } from "../server/local-auth.js";
import type { HostConfig } from "../server/config.js";
export async function serverFixture(
  mode: "cloudflare" | "local" = "cloudflare",
  seeded = false,
  approvedOrigins: string[] = [],
) {
  const metadata = JSON.parse(
    readFileSync(
      new URL("./fixtures/netdata-discovery.json", import.meta.url),
      "utf8",
    ),
  );
  let calls = 0,
    chartStatus = 200,
    contextStatus = 200,
    nodesStatus = 200,
    malformed = false,
    delay = 0;
  const agent = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url!, "http://fixture");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(malformed ? "invalid-json" : JSON.stringify(value));
    };
    const respond = () => {
      if (u.pathname === "/api/v3/nodes")
        return send({ nodes: metadata.nodes }, nodesStatus);
      const guid = u.pathname.split("/")[2],
        node = metadata.nodes.find((n: any) => n.mg === guid);
      if (u.pathname.endsWith("/charts"))
        return send(
          { hostname: node?.nm, charts: metadata.charts },
          chartStatus,
        );
      if (u.pathname === "/api/v3/contexts")
        return send(
          {
            contexts: Object.fromEntries(
              Object.values(metadata.charts).map((c: any) => [c.context, {}]),
            ),
          },
          contextStatus,
        );
      if (u.pathname === "/api/v3/alerts")
        return send({ alerts: [], nodes: [], alert_instances: [] });
      if (u.pathname === "/api/v3/data")
        return send({
          summary: { nodes: [{ mg: u.searchParams.get("nodes") }] },
          result: {
            labels: ["time", "user"],
            data: [[Math.floor(Date.now() / 1000) - 1, 10]],
          },
          view: {
            dimensions: {
              ids: ["user,system.cpu@" + u.searchParams.get("nodes")],
            },
          },
        });
      send({}, 404);
    };
    if (delay) setTimeout(respond, delay);
    else respond();
  });
  await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(agent.address() as { port: number }).port}`;
  const app = express(),
    listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => listener.once("listening", r));
  const origin = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "hb-servers-"));
  const filename = path.join(dir, "monitor.sqlite");
  const store = new Configuration(filename, ChecksSchema.parse({}));
  const monitor = new Monitor(store.runtime(), store.db, null);
  const seed: HostConfig[] = seeded
    ? metadata.nodes.map((n: any, i: number) => ({
        id: `existing-${i}`,
        name: n.nm,
        url,
        node: n.nm,
      }))
    : [];
  const trust = new AgentTrust(
    [url, ...approvedOrigins].map((url) => ({ url, addresses: ["127.0.0.1"] })),
  );
  const registry = new Servers(store, trust, seed);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const admin: AdminConfig =
    mode === "cloudflare"
      ? {
          issuer: "https://fixture.cloudflareaccess.com",
          audience: "fixture",
          emails: ["admin@example.com"],
          origin,
          targets: [],
        }
      : {
          mode: "local",
          origin,
          username: "operator",
          passwordHash: await hash("a-long-fixture-password", {
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 1,
          }),
          sessionSecret: randomBytes(32).toString("hex"),
          trustedProxies: [],
          targets: [],
        };
  let stopSessions = () => {};
  if (admin.mode === "local") stopSessions = localAuthentication(app, admin);
  const auth = authorization(admin, createLocalJWKSet({ keys: [jwk] }));
  const jwt =
    mode === "cloudflare"
      ? await new SignJWT({ email: "admin@example.com" })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer("https://fixture.cloudflareaccess.com")
          .setAudience("fixture")
          .setSubject("admin")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey)
      : "";
  app.use("/api/admin/servers", registry.api(admin, auth));
  app.use(
    "/api",
    configAPI(store, monitor, admin, () => registry.ids(), auth),
  );
  app.get("/api/fleet", async (_req, res) =>
    res.json({
      hosts: await registry.fleet(),
      groups: registry.groups(),
      generatedAt: new Date().toISOString(),
      refreshSeconds: 10,
    }),
  );
  app.get("/api/monitor", (_req, res) => res.json(monitor.view()));
  app.get("/api/hosts/:id/history", (_req, res) =>
    res.json({
      points: [],
      range: "1h",
      errors: [],
      fetchedAt: new Date().toISOString(),
    }),
  );
  app.use(express.static(path.resolve("dist/client")));
  app.get(/.*/, (_req, res) =>
    res.sendFile(path.resolve("dist/client/index.html")),
  );
  synchronize(store, monitor);
  const call = async (
    route: string,
    body?: unknown,
    method = "POST",
    extra: Record<string, string> = {},
  ) => {
    const r = await fetch(origin + "/api/admin/servers" + route, {
      method: body === undefined ? "GET" : method,
      headers: {
        "Cf-Access-Jwt-Assertion": jwt,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Hostboard-Request": "1",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  return {
    app,
    origin,
    url,
    metadata,
    registry,
    store,
    monitor,
    trust,
    seed,
    filename,
    jwt,
    call,
    get calls() {
      return calls;
    },
    setFailure: (charts = 200, contexts = 200, nodes = 200) => {
      chartStatus = charts;
      contextStatus = contexts;
      nodesStatus = nodes;
    },
    setMalformed: (value: boolean) => {
      malformed = value;
    },
    setDelay: (value: number) => {
      delay = value;
    },
    resetLimit: () =>
      store.db
        .prepare("DELETE FROM action_limits WHERE action='agent-test'")
        .run(),
    close: () => {
      monitor.stop();
      stopSessions();
      agent.closeAllConnections();
      agent.close();
      listener.closeAllConnections();
      listener.close();
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
