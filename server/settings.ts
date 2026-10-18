import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CheckSchema,
  type CheckConfig,
  type ChecksConfig,
} from "./check-config.js";
export const GeneralSchema = z
  .object({
    refreshSeconds: z.number().int().min(10).max(300),
    temperature: z.enum(["C", "F"]),
    range: z.enum(["15m", "1h", "6h", "24h"]),
    landing: z.enum(["overview", "servers", "services", "issues", "settings"]),
    compact: z.boolean(),
  })
  .strict();
export const NotificationSchema = z
  .object({
    enabled: z.boolean(),
    recipients: z.array(z.email()).max(20),
    minimumSeverity: z.enum(["warning", "critical"]),
    cooldownSeconds: z.number().int().min(0).max(86400),
    recovery: z.boolean(),
  })
  .strict();
export const SettingsSchema = z
  .object({
    general: GeneralSchema,
    notifications: NotificationSchema,
    retention: z
      .object({
        sampleDays: z.number().int().min(30).max(365),
        incidentDays: z.literal(0),
      })
      .strict(),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const defaults: Settings = {
  general: {
    refreshSeconds: 10,
    temperature: "C",
    range: "1h",
    landing: "overview",
    compact: false,
  },
  notifications: {
    enabled: true,
    recipients: [],
    minimumSeverity: "warning",
    cooldownSeconds: 0,
    recovery: true,
  },
  retention: { sampleDays: 30, incidentDays: 0 },
};
export interface ManagedCheck {
  definition: CheckConfig;
  enabled: boolean;
  deleted: boolean;
}
export class Configuration {
  readonly db: DatabaseSync;
  constructor(
    readonly filename: string,
    seed: ChecksConfig,
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    const schema = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (schema.user_version > 2) {
      this.db.close();
      throw Error(
        "Configuration database was created by a newer Hostboard release",
      );
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS service_config(id TEXT PRIMARY KEY,definition TEXT NOT NULL,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS config_audit(id INTEGER PRIMARY KEY,time REAL NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_limits(action TEXT PRIMARY KEY,time REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_tests(id INTEGER PRIMARY KEY,time REAL NOT NULL,state TEXT NOT NULL);
      PRAGMA user_version=${Math.max(1,schema.user_version)};`);
    if (!this.db.prepare("SELECT id FROM app_settings WHERE id=1").get())
      this.atomic(() => {
        const initial = structuredClone(defaults);
        initial.notifications.minimumSeverity = seed.minimumSeverity;
        this.db
          .prepare("INSERT INTO app_settings VALUES(1,?,1)")
          .run(JSON.stringify(initial));
        for (const c of seed.checks)
          this.db
            .prepare("INSERT INTO service_config VALUES(?,?,1,0)")
            .run(c.id, JSON.stringify(c));
      });
    this.settings();
    this.checks(); // Refuse corrupted or incompatible configuration at startup.
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async backup() {
    if (this.filename === ":memory:") return;
    const directory = path.join(path.dirname(this.filename), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    await backup(
      this.db,
      path.join(
        directory,
        `before-retention-${Date.now()}-${randomUUID()}.sqlite`,
      ),
    );
  }
  revision() {
    return (
      this.db.prepare("SELECT revision FROM app_settings WHERE id=1").get() as {
        revision: number;
      }
    ).revision;
  }
  settings(): Settings {
    return SettingsSchema.parse(
      JSON.parse(
        (
          this.db
            .prepare("SELECT value FROM app_settings WHERE id=1")
            .get() as { value: string }
        ).value,
      ),
    );
  }
  checks(): ManagedCheck[] {
    return (
      this.db
        .prepare("SELECT * FROM service_config ORDER BY rowid")
        .all() as unknown as {
        definition: string;
        enabled: number;
        deleted: number;
      }[]
    ).map((r) => ({
      definition: CheckSchema.parse(JSON.parse(r.definition)),
      enabled: !!r.enabled,
      deleted: !!r.deleted,
    }));
  }
  runtime(): ChecksConfig {
    return {
      checks: this.checks().map((c) => c.definition),
      minimumSeverity: this.settings().notifications.minimumSeverity,
    };
  }
  saveSettings(value: Settings) {
    this.db
      .prepare("UPDATE app_settings SET value=?,revision=revision+1 WHERE id=1")
      .run(JSON.stringify(SettingsSchema.parse(value)));
  }
  saveCheck(c: ManagedCheck) {
    this.db
      .prepare(
        "INSERT INTO service_config VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,enabled=excluded.enabled,deleted=excluded.deleted",
      )
      .run(
        c.definition.id,
        JSON.stringify(c.definition),
        Number(c.enabled),
        Number(c.deleted),
      );
    this.bump();
  }
  bump() {
    this.db.exec("UPDATE app_settings SET revision=revision+1 WHERE id=1");
  }
  audit(actor: string, action: string) {
    this.db
      .prepare("INSERT INTO config_audit(time,actor,action) VALUES(?,?,?)")
      .run(Date.now() / 1000, actor, action);
  }
  limit(action: string, seconds: number) {
    const now = Date.now() / 1000;
    const row = this.db
      .prepare("SELECT time FROM action_limits WHERE action=?")
      .get(action) as { time: number } | undefined;
    if (row && now - row.time < seconds) return false;
    this.db
      .prepare(
        "INSERT INTO action_limits VALUES(?,?) ON CONFLICT(action) DO UPDATE SET time=excluded.time",
      )
      .run(action, now);
    return true;
  }
}
