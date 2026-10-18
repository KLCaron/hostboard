import express from "express";
import { readFileSync } from "node:fs";
import { validateWindow } from "./investigation.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, privateBind } from "./config.js";
import { Agent, RANGES } from "./netdata.js";
import type { Range } from "../src/types.js";
import { loadChecks } from "./check-config.js";
import { Monitor } from "./monitor.js";
import { smtpDelivery } from "./notifications.js";
import { bootstrapTargets } from "./targets.js";
import { Configuration } from "./settings.js";
import { loadAdmin } from "./admin.js";
import { rateLimit } from "express-rate-limit";
import { localAuthentication } from "./local-auth.js";
import { configAPI, synchronize } from "./config-api.js";
process.umask(0o077);
const admin = loadAdmin();
if (!admin)
  throw Error(
    "Administrator configuration is missing. Run scripts/setup.sh before starting Hostboard.",
  );
const agents = loadConfig().hosts.map((host) => new Agent(host));
const seed = loadChecks(agents.map((a) => a.config.id));
const configuration = new Configuration(
  process.env.HOSTBOARD_DB || "data/monitor.sqlite",
  seed,
);
const monitor = new Monitor(
  configuration.runtime(),
  configuration.db,
  smtpDelivery(() => configuration.settings().notifications),
);
synchronize(configuration, monitor);
const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  next();
});
app.get("/api/health", (_req, res) =>
  res
    .status(monitor.healthy() ? 200 : 503)
    .json({ status: monitor.healthy() ? "ok" : "unavailable" }),
);
app.get("/api/monitor-health", (_req, res) =>
  res
    .status(monitor.healthy() ? 200 : 503)
    .json({ status: monitor.healthy() ? "ok" : "unavailable" }),
);
const stopSessions =
  admin.mode === "local" ? localAuthentication(app, admin) : () => {};
app.use(
  "/api",
  rateLimit({
    windowMs: 60000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }),
);
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use(
  "/api",
  configAPI(
    configuration,
    monitor,
    admin,
    agents.map((a) => a.config.id),
    undefined,
    bootstrapTargets(seed.checks),
  ),
);
app.get("/api/system", async (_req, res) => {
  const hosts = await Promise.all(agents.map((a) => a.current()));
  const view = monitor.view(undefined, undefined, false);
  res.json({
    version: JSON.parse(readFileSync(path.resolve("package.json"), "utf8"))
      .version,
    generatedAt: Date.now() / 1000,
    servers: hosts.map((h) => ({
      id: h.id,
      name: h.name,
      status: h.status,
      lastSeen: h.lastSeen,
    })),
    activeChecks: view.checks.filter((c) => c.state !== "disabled").length,
    scheduler: view.healthy,
    watchdogs: view.checks
      .filter((c) =>
        configuration
          .checks()
          .some(
            (x) =>
              x.definition.id === c.id &&
              x.definition.type === "http" &&
              x.definition.watchdogHistory,
          ),
      )
      .map((c) => ({ name: c.name, state: c.state, checkedAt: c.checkedAt })),
    notificationOwner:
      "Hostboard services only; Netdata and watchdog are independently configured",
    incidentRetention: "Indefinite",
    sampleDays: view.retentionDays,
  });
});

app.get("/api/monitor", async (req, res) => {
  const before = req.query.before;
  if (
    before !== undefined &&
    (typeof before !== "string" ||
      !/^\d{1,15}$/.test(before) ||
      Number(before) < 1)
  ) {
    res.status(400).json({ error: "Invalid incident cursor" });
    return;
  }
  res.json(
    await monitor.viewAsync(
      undefined,
      before === undefined ? undefined : Number(before),
    ),
  );
});
// Authenticated in local mode, behind Access in Cloudflare mode, like other history reads.
app.get("/api/checks/:id/history", (req, res) => {
  const generation = req.query.generation;
  if (typeof generation !== "string" || !/^[1-9]\d{0,8}$/.test(generation)) {
    res.status(400).json({ error: "Choose a historical generation" });
    return;
  }
  const history = monitor.historyFor(req.params.id, Number(generation));
  if (!history) {
    res.status(404).json({ error: "Unknown check generation" });
    return;
  }
  res.json({ ...history, generations: monitor.generations(req.params.id) });
});
app.get("/api/incidents/:id", async (req, res) => {
  if (!/^\d{1,15}$/.test(req.params.id)) {
    res.status(400).json({ error: "Invalid incident ID" });
    return;
  }
  const id = Number(req.params.id);
  const incident = monitor
    .view(undefined, id + 1, false)
    .incidents.find((i) => i.id === id);
  if (!incident) {
    res.status(404).json({ error: "Unknown incident" });
    return;
  }
  res.json(incident);
});
app.get("/api/fleet", async (_req, res) =>
  res.json({
    hosts: await Promise.all(agents.map((agent) => agent.current())),
    generatedAt: new Date().toISOString(),
    refreshSeconds: 10,
  }),
);
app.get("/api/hosts/:id/health", async (req, res) => {
  const agent = agents.find((a) => a.config.id === req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Unknown host" });
    return;
  }
  const host = await agent.current();
  res
    .status(host.status === "online" ? 200 : 503)
    .json({ status: host.status === "online" ? "ok" : "unavailable" });
});
app.get("/api/hosts/:id/history", async (req, res) => {
  const agent = agents.find((a) => a.config.id === req.params.id);
  if (!agent) {
    res.status(404).json({ error: "Unknown host" });
    return;
  }
  const range = req.query.range ?? "1h";
  if (typeof range !== "string" || !Object.hasOwn(RANGES, range)) {
    res.status(400).json({ error: "Invalid time range" });
    return;
  }
  try {
    res.json(await agent.history(range as Range));
  } catch {
    res.status(502).json({ error: "Agent history is unavailable" });
  }
});
// Investigation requests accept exact catalog IDs, never caller-provided Agent URLs.
for (const endpoint of [
  "metrics",
  "diagnostics",
  "alerts",
  "metric-history",
] as const) {
  app.get(`/api/hosts/:id/${endpoint}`, async (req, res) => {
    const agent = agents.find((a) => a.config.id === req.params.id);
    if (!agent) {
      res.status(404).json({ error: "Unknown host" });
      return;
    }
    let window;
    if (endpoint === "metric-history") {
      if (typeof req.query.chart !== "string" || req.query.chart.length > 512) {
        res.status(400).json({ error: "Choose a metric chart" });
        return;
      }
      try {
        window = validateWindow(req.query.after, req.query.before);
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
    }
    try {
      if (endpoint === "metrics") res.json(await agent.catalog());
      else if (endpoint === "diagnostics") res.json(await agent.diagnostics());
      else if (endpoint === "alerts") res.json(await agent.alertDetails());
      else {
        if (!(await agent.catalog()).some((c) => c.id === req.query.chart)) {
          res
            .status(404)
            .json({ error: "Metric is no longer available on this host" });
          return;
        }
        res.json(await agent.metricHistory(req.query.chart as string, window!));
      }
    } catch {
      res.status(502).json({
        error:
          "Agent investigation data unavailable. Check the host connection and retry.",
      });
    }
  });
}
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown endpoint" }),
);
app.use(((error, _req, res, _next) => {
  console.error(
    "Request failed:",
    error instanceof Error ? error.name : "Unknown error",
  );
  res.status(500).json({ error: "Request failed. Check the server logs." });
}) as express.ErrorRequestHandler);
const client = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client",
);
app.use(express.static(client, { maxAge: "1h", index: false }));
app.get(
  [
    "/",
    "/overview",
    "/servers",
    "/services",
    "/issues",
    "/settings",
    "/alerts",
    "/incidents",
  ],
  (_req, res) =>
    res.sendFile(path.join(client, "index.html"), {
      headers: { "Cache-Control": "no-cache" },
    }),
);
const bind = process.env.HOSTBOARD_BIND || "127.0.0.1",
  port = Number(process.env.PORT || 3001);
if (
  !privateBind(bind) &&
  !(bind === "0.0.0.0" && process.env.HOSTBOARD_CONTAINER === "1")
)
  throw new Error(
    "HOSTBOARD_BIND must be loopback, a private LAN address, or a VPN address",
  );
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be between 1024 and 65535");
// Same-host proxies can use localhost while browsers on the LAN use the
// configured private address. Never bind all interfaces to enable both.
const addresses = ["127.0.0.1", "::1", "0.0.0.0"].includes(bind)
  ? [bind]
  : [bind, "127.0.0.1"];
let listening = 0;
const servers = addresses.map((address) =>
  app.listen(port, address, () => {
    console.log(
      `Hostboard listening on ${address}:${port}; ${agents.length} hosts configured`,
    );
    // Self-checks must not race the HTTP listeners during startup.
    if (++listening === addresses.length) monitor.start();
  }),
);
process.on("SIGTERM", () => {
  monitor.stop();
  stopSessions();
  let remaining = servers.length;
  for (const server of servers) {
    server.close(() => {
      if (--remaining === 0) process.exit(0);
    });
  }
});
