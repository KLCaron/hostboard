// Run after npm run build. Uses complete built applications and isolated endpoints;
// no SMTP configuration or production network destination is supplied.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { hash } from "argon2";
import { Configuration } from "../server/settings.js";
import { Monitor } from "../server/monitor.js";
import { ChecksSchema } from "../server/check-config.js";
import { fixtureAgent } from "./fixture-agent.js";

const dir = mkdtempSync(path.join(tmpdir(), "hb-reliability-integration-"));
const agent = fixtureAgent();
await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
const agentOrigin = `http://127.0.0.1:${(agent.address() as net.AddressInfo).port}`;
const freePort = async () => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
};
const json = (file: string, value: unknown) =>
  writeFileSync(path.join(dir, file), JSON.stringify(value), { mode: 0o600 });
const processes = new Set<ChildProcess>();
async function stop(p: ChildProcess) {
  if (p.exitCode === null) {
    p.kill("SIGTERM");
    await once(p, "exit");
  }
  processes.delete(p);
}
async function built(
  mode: "local" | "cloudflare",
  db: string,
  checks: unknown,
  instrument = false,
) {
  const port = await freePort();
  json("hosts.json", {
    hosts: [
      { id: "host", name: "Host", url: agentOrigin, node: "fixture-server" },
    ],
  });
  json("checks.json", checks);
  const shared = {
    origin:
      mode === "local" ? `http://127.0.0.1:${port}` : "https://example.test",
    targets: [
      {
        host: "127.0.0.1",
        port: Number(new URL(agentOrigin).port),
        addresses: ["127.0.0.1"],
      },
    ],
  };
  json(
    "admin.json",
    mode === "local"
      ? {
          ...shared,
          mode,
          username: "operator",
          passwordHash: await hash("fixture-only", {
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 1,
          }),
          sessionSecret: "0".repeat(64),
          trustedProxies: [],
        }
      : {
          ...shared,
          mode,
          issuer: "https://fixture.cloudflareaccess.com",
          audience: "fixture",
          emails: ["operator@example.test"],
        },
  );
  const p = spawn(
    process.execPath,
    [
      ...(instrument ? ["--import", path.join(dir, "event-loop.mjs")] : []),
      "dist/server/server/index.js",
    ],
    {
      env: {
        ...process.env,
        HOSTBOARD_BIND: "127.0.0.1",
        PORT: String(port),
        HOSTBOARD_DB: db,
        HOSTBOARD_CONFIG: path.join(dir, "hosts.json"),
        HOSTBOARD_CHECKS: path.join(dir, "checks.json"),
        HOSTBOARD_ADMIN_CONFIG: path.join(dir, "admin.json"),
        HOSTBOARD_SMTP_CONFIG: path.join(dir, "absent-smtp"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  processes.add(p);
  let stderr = "";
  p.stderr!.on("data", (b) => (stderr += String(b)));
  const origin = `http://127.0.0.1:${port}`;
  const until = Date.now() + 10000;
  while (true) {
    try {
      await fetch(origin + "/api/health");
      break;
    } catch {
      if (Date.now() > until || p.exitCode !== null)
        throw Error("Built server unavailable " + stderr);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return { p, origin };
}
try {
  for (const mode of ["local", "cloudflare"] as const) {
    const app = await built(mode, path.join(dir, mode + ".sqlite"), {
      checks: [],
    });
    assert.equal(
      (await fetch(app.origin + "/api/fleet")).status,
      mode === "local" ? 401 : 200,
    );
    assert.equal(
      (await fetch(app.origin + "/api/admin/config")).status,
      mode === "local" ? 401 : 403,
    );
    const watchdog = spawn(
      "python3",
      [
        "-c",
        `import sys;sys.path.insert(0,'scripts');from watchdog import check;print(check(sys.argv[1],'host'))`,
        app.origin,
      ],
      {
        env: {
          ...process.env,
          HOSTBOARD_WATCH_AGENTS: JSON.stringify([
            { url: agentOrigin, node: "fixture-server" },
          ]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    watchdog.stdout!.on("data", (b) => (output += String(b)));
    watchdog.stderr!.on("data", (b) => (output += String(b)));
    assert.equal((await once(watchdog, "exit"))[0], 0, output);
    console.log(
      `PASS HB-006 built ${mode} auth watchdog, direct Agent and protected administrator API`,
    );
    await stop(app.p);
  }
  // 100 checks x 8640 observations = a complete day at the supported 10s interval.
  const port = Number(new URL(agentOrigin).port);
  const checks = ChecksSchema.parse({
    checks: Array.from({ length: 100 }, (_, i) => ({
      id: "c" + i,
      name: "Check " + i,
      hostId: "host",
      type: "http",
      url: agentOrigin + "/health",
      intervalSeconds: 10,
      timeoutMs: 9000,
      notify: false,
    })),
  });
  const filename = path.join(dir, "scale.sqlite");
  const store = new Configuration(filename, checks);
  const monitor = new Monitor(checks, store.db, null);
  const start = Math.floor(Date.now() / 1000) - 86400;
  store.db.exec("BEGIN");
  const insert = store.db.prepare(
    `WITH RECURSIVE t(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM t WHERE n<8639) INSERT INTO samples(checkId,time,ok,ms,interval,generation) SELECT ?,?+n*10,CASE WHEN n%47=0 THEN 0 WHEN n%113=0 THEN NULL ELSE 1 END,6,10,1 FROM t`,
  );
  for (const c of checks.checks) insert.run(c.id, start);
  store.db.exec("COMMIT");
  assert.match(
    JSON.stringify(
      store.db
        .prepare("EXPLAIN QUERY PLAN DELETE FROM samples WHERE time<?")
        .all(start),
    ),
    /sample_time/,
  );
  store.db.close();
  writeFileSync(
    path.join(dir, "event-loop.mjs"),
    `import {monitorEventLoopDelay} from 'node:perf_hooks';import {writeFileSync} from 'node:fs';const h=monitorEventLoopDelay({resolution:10});h.enable();process.on('SIGUSR1',()=>h.reset());process.on('SIGUSR2',()=>writeFileSync(${JSON.stringify(path.join(dir, "event-loop.json"))},JSON.stringify({maxMs:h.max/1e6,p99Ms:h.percentile(99)/1e6})));`,
  );
  const app = await built("cloudflare", filename, checks, true);
  app.p.kill("SIGUSR1");
  const latencies: number[] = [];
  let watching = true;
  const health = (async () => {
    while (watching) {
      const t = performance.now();
      await fetch(app.origin + "/api/health");
      latencies.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const began = performance.now();
  // CPU work in history runs in the child app; measure its heartbeat via independent HTTP requests.
  const response = await fetch(app.origin + "/api/monitor");
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.checks.length, 100);
  const elapsed = performance.now() - began;
  const systemStart = performance.now();
  assert.equal((await fetch(app.origin + "/api/system")).status, 200);
  const systemMs = performance.now() - systemStart;
  const cachedStart = performance.now();
  await (await fetch(app.origin + "/api/monitor")).arrayBuffer();
  const cachedMs = performance.now() - cachedStart;
  watching = false;
  await health;
  const worst = Math.max(...latencies);
  app.p.kill("SIGUSR2");
  for (
    let i = 0;
    i < 100 && !existsSync(path.join(dir, "event-loop.json"));
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const loop = JSON.parse(
    readFileSync(path.join(dir, "event-loop.json"), "utf8"),
  );
  assert(loop.maxMs < 300, `event loop paused ${loop.maxMs}ms`);
  console.log(
    JSON.stringify({
      HB008: {
        samples: 864000,
        coldHistoryMs: elapsed,
        cachedHistoryMs: cachedMs,
        systemMs,
        healthRequests: latencies.length,
        maxHealthLatencyMs: worst,
        eventLoop: loop,
      },
    }),
  );
  assert(
    latencies.length >= 3,
    "health requests make progress during history computation",
  );
  assert(worst < 500, `history blocked health HTTP for ${worst}ms`);
  assert(elapsed < 6000, `cold history took ${elapsed}ms`);
  assert(cachedMs < 500);
  assert(systemMs < 500);
  await stop(app.p);
} finally {
  for (const p of processes) await stop(p);
  agent.closeAllConnections();
  await new Promise<void>((r) => agent.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}
