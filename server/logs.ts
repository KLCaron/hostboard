// SPDX-License-Identifier: AGPL-3.0-only
import express, { Router, type ErrorRequestHandler } from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { authorization, type AdminConfig } from "./admin.js";
import { privateBind } from "./config.js";
import type { Configuration } from "./settings.js";
import type { Monitor } from "./monitor.js";
import type { LogSource, LogQuery, LogResult } from "../src/log-types.js";
const slug = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
const cursorSchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    time: timestamp,
    skip: z.number().int().min(0).max(100000),
  })
  .strict();
export const LogQuerySchema = z
  .object({
    source: slug,
    after: timestamp,
    before: timestamp,
    search: z.string().max(256).default(""),
    caseSensitive: z.boolean().default(false),
    stream: z.enum(["all", "stdout", "stderr", "combined"]).default("all"),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .superRefine((q, c) => {
    const a = Date.parse(q.after),
      b = Date.parse(q.before);
    if (
      a < 0 ||
      a >= b ||
      b - a > 86400000 ||
      b > Date.now() + 60000 ||
      (q.cursor &&
        (Date.parse(q.cursor.time) < a || Date.parse(q.cursor.time) > b))
    )
      c.addIssue({
        code: "custom",
        message: "Choose a valid range of at most 24 hours",
      });
  });
const ConfigSchema = z
  .object({
    hosts: z
      .array(
        z
          .object({
            hostId: slug,
            address: z
              .string()
              .refine((v) => !!isIP(v) && privateBind(v) && v !== "0.0.0.0"),
            port: z.number().int().min(1).max(65535).default(22),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type LogConfig = z.infer<typeof ConfigSchema>;
export function loadLogConfig(hostIds: string[]) {
  const file = process.env.HOSTBOARD_LOG_CONFIG || "private/logs.json";
  if (!existsSync(file)) return { hosts: [] };
  const value = ConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    new Set(value.hosts.map((h) => h.hostId)).size !== value.hosts.length ||
    value.hosts.some((h) => !hostIds.includes(h.hostId))
  )
    throw Error("Invalid log host associations");
  return value;
}
// Providers return approved sources, never arbitrary URLs, shell commands or paths.
export interface LogProvider {
  sources(hostId: string, signal: AbortSignal): Promise<LogSource[]>;
  query(
    hostId: string,
    query: LogQuery,
    signal: AbortSignal,
  ): Promise<LogResult>;
}
export class SSHLogProvider implements LogProvider {
  active = 0;
  constructor(
    readonly config: LogConfig,
    readonly directory = path.resolve(
      path.dirname(process.env.HOSTBOARD_LOG_CONFIG || "private/logs.json"),
      "logs",
    ),
  ) {}
  async call(
    hostId: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const host = this.config.hosts.find((h) => h.hostId === hostId);
    if (!host)
      throw Error(
        "Logs are not configured for this host. An operator must enable the optional log adapter.",
      );
    if (this.active >= 4) throw Error("Log reader busy. Retry shortly.");
    signal.throwIfAborted();
    this.active++;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(
          "ssh",
          [
            "-F",
            "/dev/null",
            "-T",
            "-a",
            "-x",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `UserKnownHostsFile=${path.join(this.directory, "known_hosts")}`,
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ProxyCommand=none",
            "-o",
            "ConnectTimeout=3",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "LogLevel=ERROR",
            "-i",
            path.join(this.directory, "id_ed25519"),
            "-p",
            String(host.port),
            "-l",
            "hostboard-logs",
            host.address,
            "hostboard-logs-v1",
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: { PATH: process.env.PATH, HOME: "/nonexistent", LANG: "C" },
          },
        );
        let body = Buffer.alloc(0),
          done = false;
        const finish = (error?: Error, result?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          if (error) child.kill("SIGKILL");
          error ? reject(error) : resolve(result);
        };
        const cancel = () => finish(Error("Log query cancelled"));
        const timer = setTimeout(
          () =>
            finish(
              Error("Log query timed out. Narrow the time range and retry."),
            ),
          10000,
        );
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        child.on("error", () => finish(Error("SSH log reader unavailable")));
        child.stderr.on("data", () => {}); // Never forward transport diagnostics or credentials to clients.
        child.stdout.on("data", (chunk: Buffer) => {
          if (body.length + chunk.length > 700000)
            finish(Error("Log response exceeds limit"));
          else body = Buffer.concat([body, chunk]);
        });
        child.stdin.on("error", () => {});
        child.on("close", () => {
          if (done) return;
          try {
            const result = JSON.parse(body.toString("utf8"));
            if (typeof result?.error === "string") finish(Error(result.error));
            else finish(undefined, result);
          } catch {
            finish(
              Error(
                "Log adapter unavailable. Check its approved sources, SSH key and pinned host key.",
              ),
            );
          }
        });
        child.stdin.end(JSON.stringify(value));
      });
    } finally {
      this.active--;
    }
  }
  async sources(hostId: string, signal: AbortSignal): Promise<LogSource[]> {
    if (!this.config.hosts.some((h) => h.hostId === hostId)) return [];
    const result = z
      .object({
        sources: z
          .array(
            z
              .object({
                id: slug,
                name: z.string().max(100),
                available: z.boolean(),
                error: z.string().max(240).optional(),
                containerId: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
                containerName: z.string().max(256).optional(),
                created: z.string().max(64).optional(),
                driver: z.string().max(80).optional(),
                tty: z.boolean().optional(),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(await this.call(hostId, { op: "sources" }, signal));
    return result.sources.map((s) => ({ ...s, hostId }));
  }
  async query(
    hostId: string,
    query: LogQuery,
    signal: AbortSignal,
  ): Promise<LogResult> {
    return z
      .object({
        containerId: z.string().regex(/^[a-f0-9]{64}$/),
        containerName: z.string().max(256),
        created: z.string().max(64),
        driver: z.string().max(80),
        tty: z.boolean(),
        entries: z
          .array(
            z
              .object({
                time: timestamp,
                stream: z.enum(["stdout", "stderr", "combined"]),
                text: z.string().max(18000),
                truncated: z.boolean(),
              })
              .strict(),
          )
          .max(500),
        truncated: z.boolean(),
        nextCursor: cursorSchema.nullable(),
        resumeCursor: cursorSchema.nullable(),
        scannedBytes: z.number().int().min(0).max(2100000),
        notice: z.string().max(500),
        incomplete: z.boolean(),
      })
      .strict()
      .parse(await this.call(hostId, { op: "query", ...query }, signal));
  }
}
const ContextSchema = z
  .object({
    hostId: slug,
    serviceId: slug.optional(),
    generation: z.number().int().positive().optional(),
    container: z.string().min(1).max(256).optional(),
    incidentId: z.number().int().positive().optional(),
  })
  .strict();
export function logsAPI(
  store: Configuration,
  monitor: Monitor,
  admin: AdminConfig,
  hostIds: string[],
  provider: LogProvider,
  auth = authorization(admin),
) {
  const router = Router();
  router.use(
    auth.guard,
    rateLimit({
      windowMs: 60000,
      limit: 90,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    express.json({ limit: "8kb" }),
  );
  // Additive, backward-compatible metadata. No raw log bodies are stored in SQLite.
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS log_mappings(context TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(context,source))",
  );
  function context(raw: unknown) {
    const c = ContextSchema.parse(raw);
    if (!hostIds.includes(c.hostId)) throw Error("Unknown host");
    if (c.incidentId) {
      const i = store.db
        .prepare("SELECT checkId,hostId,generation FROM incidents WHERE id=?")
        .get(c.incidentId) as
        | { checkId: string; hostId: string; generation: number }
        | undefined;
      if (!i || i.hostId !== c.hostId)
        throw Error("Unknown incident on this host");
      c.serviceId = i.checkId;
      c.generation = i.generation;
    }
    if (!!c.serviceId === !!c.container)
      throw Error("Choose a service or container context");
    if (c.serviceId) {
      const current = monitor
        .view(undefined, undefined, false)
        .checks.find((x) => x.id === c.serviceId);
      c.generation ??= current?.generation;
      const row = c.generation
        ? (store.db
            .prepare(
              "SELECT targetMetadata FROM check_generations WHERE checkId=? AND generation=?",
            )
            .get(c.serviceId, c.generation) as
            | { targetMetadata: string | null }
            | undefined)
        : undefined;
      const historicalHost = row?.targetMetadata
        ? JSON.parse(row.targetMetadata).hostId
        : undefined;
      if (
        !row ||
        (historicalHost
          ? historicalHost !== c.hostId
          : !c.incidentId &&
            (current?.hostId !== c.hostId ||
              current.generation !== c.generation))
      )
        throw Error("Historical service identity is unavailable");
    }
    return {
      value: c,
      key: JSON.stringify([
        c.hostId,
        c.serviceId ?? null,
        c.generation ?? null,
        c.container ?? null,
      ]),
    };
  }
  function mappings(key: string) {
    return (
      store.db
        .prepare(
          "SELECT source FROM log_mappings WHERE context=? ORDER BY source",
        )
        .all(key) as { source: string }[]
    ).map((r) => r.source);
  }
  // Separate audit table permits bounded retention without changing configuration revision.
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS log_access_audit(id INTEGER PRIMARY KEY,time REAL NOT NULL,actor TEXT NOT NULL,hostId TEXT NOT NULL,source TEXT NOT NULL,action TEXT NOT NULL)",
  );
  function audit(
    actor: string,
    hostId: string,
    source: string,
    action: string,
  ) {
    store.db
      .prepare(
        "INSERT INTO log_access_audit(time,actor,hostId,source,action) VALUES(?,?,?,?,?)",
      )
      .run(Date.now() / 1000, actor, hostId, source, action);
    store.db
      .prepare(
        "DELETE FROM log_access_audit WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM log_access_audit)",
      )
      .run();
  }
  function cancellation(res: express.Response) {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    return controller.signal;
  }
  router.get("/sources/:hostId", async (req, res) => {
    if (!hostIds.includes(req.params.hostId)) {
      res.status(404).json({ error: "Unknown host" });
      return;
    }
    res.json({
      sources: await provider.sources(req.params.hostId, cancellation(res)),
    });
  });
  router.post("/context", async (req, res) => {
    const c = context(req.body);
    res.json({ context: c.value, sources: mappings(c.key) });
  });
  router.put("/context", async (req, res) => {
    const value = z
        .object({ context: ContextSchema, sources: z.array(slug).max(20) })
        .strict()
        .parse(req.body),
      c = context(value.context);
    const sources = await provider.sources(c.value.hostId, cancellation(res));
    if (value.sources.some((id) => !sources.some((s) => s.id === id)))
      throw Error("Choose only approved sources on this host");
    store.atomic(() => {
      store.db.prepare("DELETE FROM log_mappings WHERE context=?").run(c.key);
      for (const id of new Set(value.sources))
        store.db.prepare("INSERT INTO log_mappings VALUES(?,?)").run(c.key, id);
      store.audit(res.locals.actor, "Updated approved log source associations");
    });
    res.json({ sources: value.sources });
  });
  let active = 0;
  router.post("/query/:hostId", async (req, res) => {
    if (!hostIds.includes(req.params.hostId)) {
      res.status(404).json({ error: "Unknown host" });
      return;
    }
    const q = LogQuerySchema.parse(req.body);
    if (active >= 4) {
      res.status(429).json({
        error: "Too many active log queries. Pause a live viewer and retry.",
      });
      return;
    }
    active++;
    try {
      const result = await provider.query(
        req.params.hostId,
        q,
        cancellation(res),
      );
      audit(res.locals.actor, req.params.hostId, q.source, "query");
      if (!res.destroyed) res.json(result);
    } finally {
      active--;
    }
  });
  router.use(((error, _req, res, _next) => {
    if (!res.destroyed)
      res
        .status(
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 502,
        )
        .json({
          error:
            error instanceof z.ZodError
              ? "Invalid log query or association"
              : error instanceof Error
                ? error.message
                : "Log source unavailable",
        });
  }) as ErrorRequestHandler);
  return router;
}
