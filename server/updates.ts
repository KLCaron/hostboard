// SPDX-License-Identifier: AGPL-3.0-only
import {
  validRegistry,
  imageRegistry,
  approvalMissing,
  type UpdatePreferences,
  type UpdateSettingsView,
} from "../src/update-settings.js";
import { updatePreview } from "../src/updates-view.js";
import express, { Router } from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { authorization, type AdminConfig } from "./admin.js";
import { privateBind } from "./config.js";
import type { Configuration } from "./settings.js";
import type { ManagedServer } from "../src/server-types.js";
import {
  updateCounts,
  type HostUpdates,
  type UpdateSnapshot,
} from "../src/update-types.js";
const slug = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
const text = z.string().max(512);
const stamp = z.number().finite().min(0).max(1e11).nullable();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const state = z.enum(["ok", "stale", "unsupported", "unavailable"]);
export const SnapshotSchema = z
  .object({
    version: z.literal(1),
    collector: z
      .object({
        approvedRegistries: z.array(z.string().refine(validRegistry)).max(200),
        packageStaleSeconds: z.number().int().min(1).max(1209600),
      })
      .strict()
      .optional(),
    hostId: slug,
    nodeGuid: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    collectedAt: z.number().finite().min(0).max(1e11),
    packages: z
      .object({
        state,
        message: text,
        checkedAt: stamp,
        metadataAt: stamp,
        rebootRequired: z.boolean().nullable(),
        manager: text,
        packages: z
          .array(
            z
              .object({
                name: text,
                installed: text,
                available: text,
                security: z.boolean().nullable(),
                sources: z.array(text).max(30),
              })
              .strict(),
          )
          .max(10000),
      })
      .strict(),
    docker: z
      .object({
        state,
        message: text,
        checkedAt: stamp,
        services: z
          .array(
            z
              .object({
                project: text,
                service: text,
                container: text,
                image: text,
                deployedImageId: digest.optional(),
                deployedManifest: digest.nullable().optional(),
                deployedConfig: digest.nullable(),
                deployedDigests: z.array(text).max(30),
                platform: text,
                state: z.enum([
                  "current",
                  "update",
                  "pinned",
                  "local",
                  "unavailable",
                ]),
                message: text,
                upstreamDigest: digest.nullable(),
                upstreamConfig: digest.nullable(),
                checkedAt: stamp,
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, c) => {
    const times = [
      s.collectedAt,
      s.packages.checkedAt,
      s.packages.metadataAt,
      s.docker.checkedAt,
      ...s.docker.services.map((x) => x.checkedAt),
    ];
    if (
      times.some((t) => t !== null && t > Date.now() / 1000 + 300) ||
      times.slice(1).some((t) => t !== null && t > s.collectedAt + 300) ||
      (s.packages.state === "ok" &&
        (!s.packages.checkedAt || !s.packages.metadataAt)) ||
      (s.docker.state === "ok" &&
        (!s.docker.checkedAt ||
          s.docker.services.some((x) => x.state === "unavailable"))) ||
      s.docker.services.some(
        (x) =>
          (x.state === "current" || x.state === "update") &&
          (!x.checkedAt ||
            !x.upstreamDigest ||
            !x.upstreamConfig ||
            (!x.deployedManifest && !x.deployedConfig) ||
            (x.state === "current") !==
              (x.deployedManifest
                ? x.deployedManifest === x.upstreamDigest
                : !!x.deployedConfig && x.deployedConfig === x.upstreamConfig)),
      )
    )
      c.addIssue({
        code: "custom",
        message: "Inconsistent update observation",
      });
  });
export const UpdateConfigSchema = z
  .object({
    intervalSeconds: z.number().int().min(3600).max(604800).default(21600),
    staleSeconds: z.number().int().min(21600).max(1209600).default(86400),
    hosts: z
      .array(
        z
          .object({
            hostId: slug,
            nodeGuid: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
            address: z
              .string()
              .refine((v) => !!isIP(v) && privateBind(v) && v !== "0.0.0.0"),
            port: z.number().int().min(1).max(65535).default(22),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (c) =>
      new Set(c.hosts.map((h) => h.hostId)).size === c.hosts.length &&
      c.staleSeconds >= c.intervalSeconds,
    "Invalid update configuration",
  );
const registry = z
  .string()
  .refine(
    validRegistry,
    "Use an exact lowercase DNS hostname, optionally with a port; no URL, IP, wildcard or path",
  );
const hostPreferences = z
  .object({
    enabled: z.boolean(),
    proposedRegistries: z
      .array(registry)
      .max(50)
      .refine((v) => new Set(v).size === v.length, "Duplicate registry"),
  })
  .strict();
export const UpdatePreferencesSchema = z
  .object({
    intervalSeconds: z.number().int().min(3600).max(604800),
    staleSeconds: z.number().int().min(21600).max(1209600),
    hosts: z.record(slug, hostPreferences),
  })
  .strict()
  .refine(
    (v) => v.staleSeconds >= v.intervalSeconds,
    "Freshness threshold must be at least the snapshot-read interval",
  );
export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;
export function loadUpdateConfig(ids: string[]): UpdateConfig {
  const file = process.env.HOSTBOARD_UPDATE_CONFIG || "private/updates.json";
  const config = UpdateConfigSchema.parse(
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { hosts: [] },
  );
  if (config.hosts.some((h) => !ids.includes(h.hostId)))
    throw Error("Unknown registered update host");
  return config;
}
export interface UpdateProvider {
  read(hostId: string, signal: AbortSignal): Promise<unknown>;
}
export class SSHUpdateProvider implements UpdateProvider {
  constructor(
    readonly config: UpdateConfig,
    readonly directory = path.resolve(
      path.dirname(
        process.env.HOSTBOARD_UPDATE_CONFIG || "private/updates.json",
      ),
      "updates",
    ),
  ) {}
  async read(hostId: string, signal: AbortSignal): Promise<unknown> {
    const h = this.config.hosts.find((h) => h.hostId === hostId);
    if (!h) throw Error("Update snapshot reader is not configured");
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
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
          String(h.port),
          "-l",
          "hostboard-updates",
          h.address,
          "hostboard-updates-v1",
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          env: { PATH: process.env.PATH, HOME: "/nonexistent", LANG: "C" },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0,
        done = false;
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        child.kill("SIGKILL");
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(Error("Snapshot read cancelled"));
      const timer = setTimeout(
        () => finish(Error("Snapshot reader timed out")),
        10000,
      );
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.on("error", () => finish(Error("Snapshot SSH reader unavailable")));
      child.stdout.on("data", (chunk: Buffer) => {
        if (size + chunk.length > 4000000)
          finish(Error("Snapshot exceeds size limit"));
        else {
          chunks.push(chunk);
          size += chunk.length;
        }
      });
      child.on("close", (code) => {
        if (done) return;
        try {
          if (code !== 0) throw Error();
          finish(
            undefined,
            JSON.parse(Buffer.concat(chunks, size).toString("utf8")),
          );
        } catch {
          finish(
            Error(
              "Snapshot unavailable. Check the collector, permissions and pinned SSH identity.",
            ),
          );
        }
      });
    });
  }
}
type Row = {
  hostId: string;
  lastAttemptAt: number | null;
  receivedAt: number | null;
  error: string | null;
  packageLastSuccessAt: number | null;
  dockerLastSuccessAt: number | null;
  snapshot: string | null;
  overview: string | null;
};
export class Updates {
  private active = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    readonly store: Configuration,
    readonly records: () => ManagedServer[],
    readonly config: UpdateConfig,
    readonly provider: UpdateProvider,
    readonly clock = () => Date.now() / 1000,
  ) {
    // Additive metadata, as with log mappings; schema-4 images can still read this DB.
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS update_snapshots(hostId TEXT PRIMARY KEY,lastAttemptAt REAL,receivedAt REAL,error TEXT,packageLastSuccessAt REAL,dockerLastSuccessAt REAL,snapshot TEXT,overview TEXT)`,
    );
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS update_preferences(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)`,
    );
    this.preferences(); // Validate persisted configuration before polling.
    // One-time bounded presentation backfill. Normal overview reads never load inventories.
    for (const row of store.db
      .prepare("SELECT hostId,overview FROM update_snapshots")
      .all() as Row[]) {
      const overview = row.overview ? JSON.parse(row.overview) : null;
      if (overview && !overview.preview) {
        try {
          const saved = store.db
            .prepare("SELECT snapshot FROM update_snapshots WHERE hostId=?")
            .get(row.hostId) as Row;
          overview.preview = updatePreview(
            saved.snapshot ? JSON.parse(saved.snapshot) : null,
          );
          store.db
            .prepare("UPDATE update_snapshots SET overview=? WHERE hostId=?")
            .run(JSON.stringify(overview), row.hostId);
        } catch {
          // A damaged legacy inventory must not prevent the rest of monitoring starting.
          console.warn("Stored update inventory preview unavailable");
        }
      }
    }
  }
  preferences(): UpdatePreferences {
    const row = this.store.db
      .prepare("SELECT value FROM update_preferences WHERE id=1")
      .get() as { value: string } | undefined;
    return UpdatePreferencesSchema.parse(
      row
        ? JSON.parse(row.value)
        : {
            intervalSeconds: this.config.intervalSeconds,
            staleSeconds: this.config.staleSeconds,
            hosts: {},
          },
    );
  }
  pollingEnabled(id: string) {
    return this.preferences().hosts[id]?.enabled !== false;
  }
  settingsView(): UpdateSettingsView {
    const preferences = this.preferences();
    return {
      revision: this.store.revision(),
      preferences,
      hosts: this.records().map((record) => {
        // Discard each inventory after extracting settings; never retain the full fleet.
        const h = this.view(true, record.id)[0];
        const reader = this.config.hosts.find((c) => c.hostId === h.hostId);
        return {
          hostId: h.hostId,
          name: h.name,
          configured: h.configured,
          paused: h.paused,
          reader: reader
            ? {
                address: reader.address,
                port: reader.port,
                nodeGuid: reader.nodeGuid,
              }
            : null,
          collectedAt: h.snapshot?.collectedAt ?? null,
          receivedAt: h.receivedAt,
          error: h.error,
          packageState: h.snapshot?.packages.state ?? "unknown",
          dockerState: h.snapshot?.docker.state ?? "unknown",
          policy: h.error?.includes("identity")
            ? null
            : (h.snapshot?.collector ?? null),
          policyStale:
            h.paused ||
            !h.configured ||
            !!h.error ||
            !h.snapshot ||
            this.clock() - h.snapshot.collectedAt > preferences.staleSeconds,
          missing:
            h.snapshot?.docker.services.filter(approvalMissing).map((s) => ({
              registry: imageRegistry(s.image),
              project: s.project,
              service: s.service,
              image: s.image,
            })) ?? [],
        };
      }),
    };
  }
  savePreferences(revision: number, actor: string, value: UpdatePreferences) {
    const parsed = UpdatePreferencesSchema.parse(value);
    if (
      Object.keys(parsed.hosts).some(
        (id) => !this.records().some((h) => h.id === id),
      )
    )
      throw Object.assign(Error("Unknown update host"), { status: 400 });
    this.store.atomic(() => {
      if (revision !== this.store.revision())
        throw Object.assign(
          Error("Configuration changed elsewhere. Reload before saving."),
          { status: 409 },
        );
      this.store.db
        .prepare(
          "INSERT INTO update_preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(parsed));
      this.store.bump();
      this.store.audit(
        actor,
        `Updated snapshot-read settings: interval=${parsed.intervalSeconds}, stale=${parsed.staleSeconds}; host preferences/proposals: ${Object.keys(parsed.hosts).join(", ") || "none"} (host policy unchanged)`,
      );
    });
    for (const [id, controller] of this.active)
      if (!this.pollingEnabled(id)) controller.abort();
  }
  view(details = true, id?: string): HostUpdates[] {
    const now = this.clock(),
      preferences = this.preferences();
    return this.records()
      .filter((h) => !id || h.id === id)
      .map((h) => {
        const row = this.store.db
          .prepare(
            details
              ? "SELECT * FROM update_snapshots WHERE hostId=?"
              : "SELECT hostId,lastAttemptAt,receivedAt,error,packageLastSuccessAt,dockerLastSuccessAt,overview FROM update_snapshots WHERE hostId=?",
          )
          .get(h.id) as Row | undefined;
        const overview = row?.overview ? JSON.parse(row.overview) : null;
        const snapshot: UpdateSnapshot | null = details
          ? row?.snapshot
            ? JSON.parse(row.snapshot)
            : null
          : overview?.snapshot || null;
        const identityMismatch = !!snapshot && h.guid !== snapshot.nodeGuid;
        if (snapshot) {
          for (const key of ["packages", "docker"] as const) {
            const s = snapshot[key];
            if (
              s.state === "ok" &&
              (h.archived ||
                !h.enabled ||
                preferences.hosts[h.id]?.enabled === false ||
                !this.config.hosts.some((x) => x.hostId === h.id) ||
                identityMismatch ||
                row?.error ||
                !s.checkedAt ||
                now - s.checkedAt > preferences.staleSeconds ||
                now - snapshot.collectedAt > preferences.staleSeconds ||
                (key === "packages" &&
                  (!snapshot.packages.metadataAt ||
                    now - snapshot.packages.metadataAt >
                      preferences.staleSeconds)))
            ) {
              s.state = "stale";
              s.message =
                "Collection or package metadata is stale; counts are last observed.";
            }
          }
        }
        return {
          preview: details ? updatePreview(snapshot) : overview?.preview,
          detailsIncluded: details,
          counts: details
            ? updateCounts(snapshot)
            : overview?.counts || updateCounts(null),
          hostId: h.id,
          name: h.name,
          groupId: h.groupId,
          archived: h.archived,
          enabled: h.enabled,
          configured: this.config.hosts.some((x) => x.hostId === h.id),
          paused:
            h.archived ||
            !h.enabled ||
            preferences.hosts[h.id]?.enabled === false,
          refreshing: this.active.has(h.id),
          lastAttemptAt: row?.lastAttemptAt ?? null,
          receivedAt: row?.receivedAt ?? null,
          error: identityMismatch
            ? "Snapshot belongs to a different registered node identity"
            : (row?.error ?? null),
          packageLastSuccessAt: row?.packageLastSuccessAt ?? null,
          dockerLastSuccessAt: row?.dockerLastSuccessAt ?? null,
          snapshot,
        };
      });
  }
  async refresh(id: string): Promise<boolean> {
    const h = this.records().find((h) => h.id === id),
      c = this.config.hosts.find((h) => h.hostId === id);
    if (
      this.stopped ||
      !this.pollingEnabled(id) ||
      !h ||
      !c ||
      h.archived ||
      !h.enabled ||
      this.active.has(id) ||
      this.active.size >= 4
    )
      return false;
    const prior = this.store.db
      .prepare("SELECT * FROM update_snapshots WHERE hostId=?")
      .get(id) as Row | undefined;
    const now = this.clock();
    // Also bounds manual refresh across clients and application restarts.
    if (prior?.lastAttemptAt != null && now - prior.lastAttemptAt < 60)
      return false;
    const controller = new AbortController();
    this.active.set(id, controller);
    this.store.db
      .prepare(
        "INSERT INTO update_snapshots(hostId,lastAttemptAt) VALUES(?,?) ON CONFLICT(hostId) DO UPDATE SET lastAttemptAt=excluded.lastAttemptAt",
      )
      .run(id, now);
    try {
      const s = SnapshotSchema.parse(
        await this.provider.read(id, controller.signal),
      );
      const current = this.records().find((x) => x.id === id);
      if (
        controller.signal.aborted ||
        !current ||
        current.archived ||
        !this.pollingEnabled(id) ||
        !current.enabled
      )
        return false;
      if (
        s.hostId !== id ||
        s.nodeGuid !== c.nodeGuid ||
        !current.guid ||
        current.guid !== s.nodeGuid
      )
        throw Error("Snapshot does not match the registered node identity");
      if (
        prior?.snapshot &&
        s.collectedAt < JSON.parse(prior.snapshot).collectedAt
      )
        throw Error("Snapshot timestamp moved backwards");
      // Keep the last successful service check time for the same deployment.
      const previous: UpdateSnapshot | null = prior?.snapshot
        ? JSON.parse(prior.snapshot)
        : null;
      for (const service of s.docker.services) {
        if (service.checkedAt === null && service.state === "unavailable") {
          const old = previous?.docker.services.find(
            (x) =>
              x.container === service.container &&
              x.image === service.image &&
              x.deployedConfig === service.deployedConfig &&
              x.deployedManifest === service.deployedManifest &&
              x.deployedImageId === service.deployedImageId,
          );
          service.checkedAt = old?.checkedAt ?? null;
        }
      }
      const success = (key: "packages" | "docker") =>
        ["ok", "stale"].includes(s[key].state)
          ? s[key].checkedAt
          : ((key === "packages"
              ? prior?.packageLastSuccessAt
              : prior?.dockerLastSuccessAt) ?? null);
      this.store.db
        .prepare(
          "UPDATE update_snapshots SET receivedAt=?,error=NULL,packageLastSuccessAt=?,dockerLastSuccessAt=?,snapshot=?,overview=? WHERE hostId=?",
        )
        .run(
          this.clock(),
          success("packages"),
          success("docker"),
          JSON.stringify(s),
          JSON.stringify({
            snapshot: {
              ...s,
              packages: { ...s.packages, packages: [] },
              docker: { ...s.docker, services: [] },
            },
            preview: updatePreview(s),
            counts: updateCounts(s),
          }),
          id,
        );
      return true;
    } catch (error) {
      // Do not expose remote output, validation payloads, credentials or transport diagnostics.
      if (!this.stopped)
        this.store.db
          .prepare("UPDATE update_snapshots SET error=? WHERE hostId=?")
          .run(
            error instanceof z.ZodError
              ? "Invalid update snapshot"
              : error instanceof Error &&
                  /identity|timestamp/.test(error.message)
                ? error.message
                : "Snapshot read failed. Check collector, SSH permissions and host availability.",
            id,
          );
      return false;
    } finally {
      this.active.delete(id);
    }
  }
  async tick() {
    for (const h of this.records()) {
      if (h.archived || !h.enabled || !this.pollingEnabled(h.id)) {
        this.active.get(h.id)?.abort();
        continue;
      }
      if (!this.config.hosts.some((c) => c.hostId === h.id)) continue;
      const row = this.store.db
        .prepare("SELECT lastAttemptAt FROM update_snapshots WHERE hostId=?")
        .get(h.id) as { lastAttemptAt: number } | undefined;
      if (
        !row ||
        this.clock() - row.lastAttemptAt >= this.preferences().intervalSeconds
      )
        void this.refresh(h.id);
    }
  }
  start() {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.active.values()) c.abort();
  }
}
export function updatesAPI(
  updates: Updates,
  admin: AdminConfig,
  auth = authorization(admin),
) {
  const router = Router();
  router.use(
    auth.guard,
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    express.json({ limit: "24kb" }),
  );
  router.get("/settings", (_req, res) => res.json(updates.settingsView()));
  router.put("/settings", (req, res) => {
    try {
      const input = z
        .object({
          revision: z.number().int().positive(),
          intervalSeconds: z.number(),
          staleSeconds: z.number(),
        })
        .strict()
        .parse(req.body);
      updates.savePreferences(input.revision, res.locals.actor, {
        ...updates.preferences(),
        intervalSeconds: input.intervalSeconds,
        staleSeconds: input.staleSeconds,
      });
      res.json(updates.settingsView());
    } catch (e) {
      settingsError(e, res);
    }
  });
  router.put("/settings/hosts/:id", (req, res) => {
    try {
      if (!updates.records().some((h) => h.id === req.params.id)) {
        res.status(404).json({ error: "Unknown update host" });
        return;
      }
      const input = z
        .object({
          revision: z.number().int().positive(),
          host: hostPreferences,
        })
        .strict()
        .parse(req.body);
      const current = updates.preferences();
      updates.savePreferences(input.revision, res.locals.actor, {
        ...current,
        hosts: { ...current.hosts, [req.params.id]: input.host },
      });
      res.json(updates.settingsView());
    } catch (e) {
      settingsError(e, res);
    }
  });
  router.get("/", (_req, res) =>
    res.json({ hosts: updates.view(false), generatedAt: Date.now() / 1000 }),
  );
  router.get("/:id", (req, res) => {
    if (!slug.safeParse(req.params.id).success) {
      res.status(400).json({ error: "Invalid host ID" });
      return;
    }
    const host = updates.view(true, req.params.id)[0];
    if (!host) {
      res.status(404).json({ error: "Unknown host" });
      return;
    }
    res.json({ host });
  });
  router.post("/:id/refresh", async (req, res) => {
    if (
      !slug.safeParse(req.params.id).success ||
      !z.object({}).strict().safeParse(req.body).success
    ) {
      res.status(400).json({ error: "Invalid status refresh" });
      return;
    }
    const h = updates.view(false, req.params.id)[0];
    if (!h) {
      res.status(404).json({ error: "Unknown host" });
      return;
    }
    if (h.paused || !h.configured) {
      res.status(409).json({
        error: "Monitoring is paused or no snapshot reader is configured",
      });
      return;
    }
    const refreshed = await updates.refresh(h.hostId);
    res.json({
      refreshed,
      host: updates.view(true, h.hostId)[0],
    });
  });
  return router;
}

function settingsError(error: unknown, res: express.Response) {
  const status =
    error instanceof z.ZodError
      ? 400
      : ((error as { status?: number }).status ?? 500);
  res.status(status).json({
    error:
      error instanceof z.ZodError
        ? "Invalid Updates settings. Check timing bounds and exact, unique registry hostnames."
        : status < 500 && error instanceof Error
          ? error.message
          : "Unable to save Updates settings",
  });
}
