import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import type { Settings } from "./settings.js";
import type { TargetPolicy } from "./targets.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChecksConfig, CheckConfig } from "./check-config.js";
import { probe, type ProbeResult } from "./probe.js";
import type { Delivery } from "./notifications.js";
import type {
  MonitorView,
  CheckView,
  IncidentView,
  NotificationView,
} from "../src/monitor-types.js";

type State = {
  id: string;
  fingerprint: string;
  checked: number | null;
  failures: number;
  firstFailure: number | null;
  active: number | null;
  ok: number | null;
  ms: number | null;
  reason: string;
  lastSent: number | null;
};
type Outbox = {
  id: number;
  incident: number;
  event: string;
  subject: string;
  body: string;
  attempts: number;
};
const seconds = () => Date.now() / 1000;
const iso = (time: number) => new Date(time * 1000).toISOString();
export class Monitor {
  readonly db: DatabaseSync;
  private readonly namespace: string;
  private timer?: ReturnType<typeof setInterval>;
  private running = new Set<string>();
  private sending = false;
  private stopped = false;
  private lastTick = 0;
  private lastPrune = 0;
  private storageError = false;
  disabled = new Set<string>();
  deleted = new Set<string>();
  preferences?: Settings;
  policy?: TargetPolicy;
  private epochs = new Map<string, number>();
  constructor(
    public config: ChecksConfig,
    filename: string | DatabaseSync,
    readonly delivery: Delivery | null,
    now = seconds(),
  ) {
    if (typeof filename === "string" && filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db =
      typeof filename === "string" ? new DatabaseSync(filename) : filename;
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS check_evaluation(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, checked REAL, failures INTEGER NOT NULL DEFAULT 0, firstFailure REAL, active INTEGER, ok INTEGER, ms REAL, reason TEXT NOT NULL DEFAULT 'Not checked yet', lastSent REAL);
      CREATE TABLE IF NOT EXISTS samples(checkId TEXT NOT NULL, time REAL NOT NULL, ok INTEGER, ms REAL, interval REAL NOT NULL, PRIMARY KEY(checkId,time));
      CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, checkId TEXT NOT NULL, name TEXT NOT NULL, hostId TEXT NOT NULL, severity TEXT NOT NULL, startedAt REAL NOT NULL, detectedAt REAL NOT NULL, endedAt REAL, reason TEXT NOT NULL, lastReason TEXT NOT NULL, responseMs REAL, resolution TEXT, monitoringGap INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS external_incidents(checkId TEXT, remoteId INTEGER, incident INTEGER UNIQUE, PRIMARY KEY(checkId,remoteId));
      CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, incident INTEGER NOT NULL, checkId TEXT NOT NULL, event TEXT NOT NULL, state TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt REAL NOT NULL, lastAttempt REAL, deliveredAt REAL, error TEXT, UNIQUE(incident,event));
      CREATE INDEX IF NOT EXISTS incident_time ON incidents(startedAt DESC);
      CREATE INDEX IF NOT EXISTS notification_due ON notifications(state,nextAttempt);`);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO metadata(key,value) VALUES('mailNamespace',?)",
      )
      .run(randomUUID());
    this.namespace = (
      this.db
        .prepare("SELECT value FROM metadata WHERE key='mailNamespace'")
        .get() as { value: string }
    ).value;
    this.configure(config, now);
    for (const row of this.db
      .prepare("SELECT * FROM checks")
      .all() as unknown as State[])
      if (row.active)
        this.db
          .prepare("UPDATE incidents SET monitoringGap=1 WHERE id=?")
          .run(row.active);
  }
  configure(
    config: ChecksConfig,
    now = seconds(),
    disabled = this.disabled,
    deleted = this.deleted,
  ) {
    for (const check of config.checks) {
      const {
        group: _group,
        name: _name,
        notify: _notify,
        cooldownSeconds: _cooldown,
        severity: _severity,
        ...evaluation
      } = check;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(evaluation))
        .digest("hex");
      const old = this.state(check.id);
      const previous = this.db
        .prepare("SELECT fingerprint FROM check_evaluation WHERE id=?")
        .get(check.id) as { fingerprint: string } | undefined;
      if (
        !this.epochs.has(check.id) ||
        previous?.fingerprint !== fingerprint ||
        this.disabled.has(check.id) !== disabled.has(check.id)
      )
        this.epochs.set(check.id, (this.epochs.get(check.id) ?? 0) + 1);
      if (old && previous && previous.fingerprint !== fingerprint) {
        if (old.active)
          this.db
            .prepare(
              "UPDATE incidents SET endedAt=?,resolution='Check configuration changed',monitoringGap=1 WHERE id=?",
            )
            .run(now, old.active);
        this.db
          .prepare(
            "UPDATE checks SET checked=NULL,ok=NULL,failures=0,firstFailure=NULL,active=NULL WHERE id=?",
          )
          .run(check.id);
        this.db
          .prepare(
            "UPDATE notifications SET state='suppressed',error='Check configuration changed' WHERE checkId=? AND state IN ('pending','failed')",
          )
          .run(check.id);
      }
      // Preserve the v0.3.1 fingerprint format for unchanged-check rollback compatibility.
      const { group: _legacyGroup, ...legacy } = check;
      const legacyFingerprint = createHash("sha256")
        .update(JSON.stringify(legacy))
        .digest("hex");
      this.db
        .prepare(
          "INSERT INTO checks(id,fingerprint) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint",
        )
        .run(check.id, legacyFingerprint);
      this.db
        .prepare(
          "INSERT INTO check_evaluation VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint",
        )
        .run(check.id, fingerprint);
    }
    this.config = config;
    this.disabled = disabled;
    this.deleted = deleted;
  }
  private state(id: string) {
    return this.db
      .prepare("SELECT * FROM checks WHERE id=?")
      .get(id) as unknown as State | undefined;
  }
  record(check: CheckConfig, result: ProbeResult, now = seconds()) {
    const old = this.state(check.id)!;
    const gap =
      old.checked !== null && now - old.checked > check.intervalSeconds * 1.5;
    let failures = result.ok === false ? (gap ? 0 : old.failures) + 1 : 0;
    let firstFailure =
      result.ok === false
        ? failures === 1
          ? now
          : (old.firstFailure ?? now)
        : null;
    let active = old.active;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO samples(checkId,time,ok,ms,interval) VALUES(?,?,?,?,?)",
        )
        .run(
          check.id,
          now,
          result.ok === null ? null : Number(result.ok),
          result.responseMs,
          check.intervalSeconds,
        );
      if (active && (gap || result.ok === null))
        this.db
          .prepare("UPDATE incidents SET monitoringGap=1 WHERE id=?")
          .run(active);
      if (
        result.ok === false &&
        !active &&
        failures >= check.failureThreshold
      ) {
        active = Number(
          this.db
            .prepare(
              "INSERT INTO incidents(checkId,name,hostId,severity,startedAt,detectedAt,reason,lastReason,responseMs) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              check.id,
              check.name,
              check.hostId,
              check.severity,
              firstFailure!,
              now,
              result.reason,
              result.reason,
              result.responseMs,
            ).lastInsertRowid,
        );
        this.enqueue(
          check,
          active,
          "outage",
          firstFailure!,
          now,
          result,
          old.lastSent,
        );
      } else if (active && result.ok === true) {
        const incident = this.db
          .prepare("SELECT startedAt FROM incidents WHERE id=?")
          .get(active) as { startedAt: number };
        this.db
          .prepare(
            "UPDATE incidents SET endedAt=?,resolution='Reachability restored',lastReason=?,responseMs=? WHERE id=?",
          )
          .run(now, result.reason, result.responseMs, active);
        this.enqueue(
          check,
          active,
          "recovery",
          incident.startedAt,
          now,
          result,
          old.lastSent,
        );
        active = null;
      } else if (active && result.ok === false)
        this.db
          .prepare("UPDATE incidents SET lastReason=?,responseMs=? WHERE id=?")
          .run(result.reason, result.responseMs, active);
      this.db
        .prepare(
          "UPDATE checks SET checked=?,failures=?,firstFailure=?,active=?,ok=?,ms=?,reason=? WHERE id=?",
        )
        .run(
          now,
          failures,
          firstFailure,
          active,
          result.ok === null ? null : Number(result.ok),
          result.responseMs,
          result.reason,
          check.id,
        );
      for (const remote of result.watchdogHistory || []) {
        let mapping = this.db
          .prepare(
            "SELECT incident FROM external_incidents WHERE checkId=? AND remoteId=?",
          )
          .get(check.id, remote.id) as { incident: number } | undefined;
        if (!mapping) {
          const id = Number(
            this.db
              .prepare(
                "INSERT INTO incidents(checkId,name,hostId,severity,startedAt,detectedAt,endedAt,reason,lastReason,resolution) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                check.id,
                remote.name,
                remote.name.split(" / ")[0],
                "critical",
                remote.startedAt,
                remote.detectedAt,
                remote.endedAt,
                remote.reason,
                remote.lastReason,
                remote.endedAt ? "Reachability restored" : null,
              ).lastInsertRowid,
          );
          this.db
            .prepare("INSERT INTO external_incidents VALUES(?,?,?)")
            .run(check.id, remote.id, id);
          mapping = { incident: id };
        } else
          this.db
            .prepare(
              "UPDATE incidents SET endedAt=?,lastReason=?,resolution=? WHERE id=?",
            )
            .run(
              remote.endedAt,
              remote.lastReason,
              remote.endedAt ? "Reachability restored" : null,
              mapping.incident,
            );
        for (const n of remote.notifications) {
          this.db
            .prepare(
              "INSERT INTO notifications(incident,checkId,event,state,subject,body,nextAttempt,attempts,lastAttempt,deliveredAt,error) VALUES(?,?,?,?, '','',0,?,?,?,?) ON CONFLICT(incident,event) DO UPDATE SET state=excluded.state,attempts=excluded.attempts,lastAttempt=excluded.lastAttempt,deliveredAt=excluded.deliveredAt,error=excluded.error",
            )
            .run(
              mapping.incident,
              check.id,
              n.event,
              "external-" + n.state,
              n.attempts,
              n.lastAttempt,
              n.deliveredAt,
              n.error,
            );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private enqueue(
    check: CheckConfig,
    incident: number,
    event: string,
    started: number,
    now: number,
    result: ProbeResult,
    lastSent: number | null,
  ) {
    const permitted =
      (this.preferences?.notifications.enabled ?? true) &&
      (event !== "recovery" ||
        (this.preferences?.notifications.recovery ?? true)) &&
      check.notify &&
      !(
        this.config.minimumSeverity === "critical" &&
        check.severity !== "critical"
      );
    const previous = this.db
      .prepare(
        "SELECT nextAttempt,state FROM notifications WHERE incident=? AND event='outage'",
      )
      .get(incident) as { nextAttempt: number; state: string } | undefined;
    const due =
      event === "recovery"
        ? Math.max(now, previous?.nextAttempt ?? now)
        : Math.max(
            now,
            (lastSent ?? 0) +
              Math.max(
                check.cooldownSeconds,
                this.preferences?.notifications.cooldownSeconds ?? 0,
              ),
          );
    const body = `${check.name} on ${check.hostId}\nState: ${event === "outage" ? "unreachable" : "reachable"}\nSeverity: ${check.severity}\nStarted: ${iso(started)}\n${event === "recovery" ? `Recovered: ${iso(now)}\nElapsed outage: ${Math.round(now - started)} seconds (may include monitoring gaps)\n` : `Confirmed: ${iso(now)}\n`}Reason: ${result.reason}\nResponse: ${result.responseMs === null ? "unknown" : Math.round(result.responseMs) + " ms"}\nCheck: ${check.id} (${check.type}); reachability does not prove full application functionality.\nDashboard: ${process.env.HOSTBOARD_PUBLIC_URL || "Hostboard"}#host=${check.hostId}\n`;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO notifications(incident,checkId,event,state,subject,body,nextAttempt) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        incident,
        check.id,
        event,
        permitted ? (this.delivery ? "pending" : "disabled") : "suppressed",
        `[Hostboard] ${event === "recovery" ? "RECOVERED" : check.severity.toUpperCase()}: ${check.hostId} / ${check.name}`,
        body,
        due,
      );
  }
  async dispatch(now = seconds()) {
    if (this.sending || !this.delivery) return;
    this.sending = true;
    try {
      // Disabled rows are deliberately not replayed automatically when a recipient is first configured.
      const rows = this.db
        .prepare(
          "SELECT * FROM notifications WHERE state IN ('pending','failed') AND nextAttempt<=? ORDER BY id LIMIT 5",
        )
        .all(now) as unknown as Outbox[];
      for (const row of rows) {
        const target = this.db
          .prepare("SELECT checkId FROM notifications WHERE id=?")
          .get(row.id) as { checkId: string };
        const definition = this.config.checks.find(
          (c) => c.id === target.checkId,
        );
        if (
          this.disabled.has(target.checkId) ||
          !definition?.notify ||
          this.preferences?.notifications.enabled === false ||
          (row.event === "recovery" &&
            this.preferences?.notifications.recovery === false) ||
          (this.config.minimumSeverity === "critical" &&
            definition.severity !== "critical")
        ) {
          this.db
            .prepare(
              "UPDATE notifications SET state='suppressed',error='Disabled by current notification or service preferences' WHERE id=?",
            )
            .run(row.id);
          continue;
        }
        const earlier = this.db
          .prepare(
            "SELECT id FROM notifications WHERE checkId=(SELECT checkId FROM notifications WHERE id=?) AND id<? AND state IN ('pending','failed') LIMIT 1",
          )
          .get(row.id, row.id);
        if (earlier) continue;
        if (row.event === "outage") {
          const check = this.config.checks.find(
            (c) =>
              c.id ===
              (
                this.db
                  .prepare("SELECT checkId FROM notifications WHERE id=?")
                  .get(row.id) as { checkId: string }
              ).checkId,
          );
          const last = check && this.state(check.id)?.lastSent;
          if (
            check &&
            last &&
            last +
              Math.max(
                check.cooldownSeconds,
                this.preferences?.notifications.cooldownSeconds ?? 0,
              ) >
              now
          ) {
            this.db
              .prepare("UPDATE notifications SET nextAttempt=? WHERE id=?")
              .run(
                last +
                  Math.max(
                    check.cooldownSeconds,
                    this.preferences?.notifications.cooldownSeconds ?? 0,
                  ),
                row.id,
              );
            continue;
          }
        }
        this.db
          .prepare(
            "UPDATE notifications SET attempts=attempts+1,lastAttempt=? WHERE id=?",
          )
          .run(now, row.id);
        try {
          const target = this.db
            .prepare("SELECT checkId FROM notifications WHERE id=?")
            .get(row.id) as { checkId: string };
          const current = this.state(target.checkId);
          const definition = this.config.checks.find(
            (c) => c.id === target.checkId,
          );
          const fresh =
            current?.checked !== null &&
            current?.checked !== undefined &&
            definition &&
            now - current.checked <= definition.intervalSeconds * 1.5;
          const state =
            !fresh || current?.ok === null
              ? "unknown (monitoring unavailable)"
              : current?.ok === 1
                ? "reachable"
                : "unreachable";
          await this.delivery.send({
            ...row,
            messageKey: `${this.namespace}-${row.id}`,
            body: row.body + `\nCurrent observed state at delivery: ${state}\n`,
          });
          this.db
            .prepare(
              "UPDATE notifications SET state='delivered',deliveredAt=?,error=NULL WHERE id=?",
            )
            .run(now, row.id);
          if (row.event === "outage")
            this.db
              .prepare(
                "UPDATE checks SET lastSent=? WHERE id=(SELECT checkId FROM notifications WHERE id=?)",
              )
              .run(now, row.id);
        } catch {
          // SMTP exceptions can contain usernames, recipients or server responses. Store a safe summary only.
          this.db
            .prepare(
              "UPDATE notifications SET state='failed',error='SMTP delivery failed; retry scheduled',nextAttempt=? WHERE id=?",
            )
            .run(
              now + Math.min(900, 30 * 2 ** Math.min(row.attempts, 5)),
              row.id,
            );
        }
      }
    } finally {
      this.sending = false;
    }
  }
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.lastTick = seconds();
      if (this.lastTick - this.lastPrune > 3600) {
        this.db
          .prepare("DELETE FROM samples WHERE time<?")
          .run(
            this.lastTick -
              (this.preferences?.retention.sampleDays ?? 30) * 86400,
          );
        this.lastPrune = this.lastTick;
      }
      for (const check of this.config.checks) {
        if (this.disabled.has(check.id)) continue;
        if (this.running.size >= 8) break;
        const state = this.state(check.id)!;
        if (
          this.running.has(check.id) ||
          (state.checked !== null &&
            this.lastTick - state.checked < check.intervalSeconds)
        )
          continue;
        this.running.add(check.id);
        const epoch = this.epochs.get(check.id);
        void probe(check, this.policy)
          .then((result) => {
            if (
              !this.stopped &&
              epoch === this.epochs.get(check.id) &&
              !this.disabled.has(check.id)
            ) {
              this.record(
                this.config.checks.find((c) => c.id === check.id)!,
                result,
              );
              this.storageError = false;
            }
          })
          .catch(() => {
            this.storageError = true;
            console.error("Service monitor could not persist a check");
          })
          .finally(() => this.running.delete(check.id));
      }
      void this.dispatch().catch(() => {
        this.storageError = true;
        console.error("Notification queue unavailable");
      });
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
  healthy(now = seconds()) {
    return (
      !this.storageError &&
      this.lastTick > 0 &&
      now - this.lastTick < 15 &&
      this.config.checks
        .filter((c) => !this.disabled.has(c.id))
        .every((c) => {
          const s = this.state(c.id)!;
          return (
            s.checked !== null &&
            now - s.checked < c.intervalSeconds * 2 + c.timeoutMs / 1000
          );
        })
    );
  }
  view(now = seconds(), before = Number.MAX_SAFE_INTEGER): MonitorView {
    const checks: CheckView[] = this.config.checks
      .filter((c) => !this.deleted.has(c.id))
      .map((c) => {
        const s = this.state(c.id)!;
        const stale =
          s.checked === null || now - s.checked > c.intervalSeconds * 1.5;
        const window = 86400,
          after = now - window;
        const samples = this.db
          .prepare(
            "SELECT time,ok,ms,interval FROM samples WHERE checkId=? AND time>=? ORDER BY time",
          )
          .all(c.id, after - c.intervalSeconds * 1.5) as unknown as {
          time: number;
          ok: number | null;
          ms: number | null;
          interval: number;
        }[];
        let up = 0,
          down = 0;
        samples.forEach((v, i) => {
          const span = Math.max(
            0,
            Math.min(
              now,
              samples[i + 1]?.time ?? now,
              v.time + v.interval * 1.5,
            ) - Math.max(after, v.time),
          );
          if (v.ok === 1) up += span;
          else if (v.ok === 0) down += span;
        });
        // At least an hour of observations and 80% coverage is needed for a meaningful daily percentage.
        const observed = up + down;
        const trend: CheckView["trend"] = [];
        for (let i = 0; i < 144; i++) {
          const start = after + i * 600;
          const bucket = samples.filter(
            (v) => v.time >= start && v.time < start + 600,
          );
          const valid = bucket.filter((v) => v.ms !== null);
          trend.push({
            time: start,
            responseMs: valid.length
              ? valid.reduce((n, v) => n + v.ms!, 0) / valid.length
              : null,
            ok: bucket.length
              ? bucket.some((v) => v.ok === 0)
                ? false
                : bucket.every((v) => v.ok === 1)
                  ? true
                  : null
              : null,
          });
        }
        return {
          id: c.id,
          name: c.name,
          hostId: c.hostId,
          container: c.container,
          type: c.type,
          group: c.group,
          lastSuccessfulAt: (
            this.db
              .prepare(
                "SELECT MAX(time) AS time FROM samples WHERE checkId=? AND ok=1",
              )
              .get(c.id) as { time: number | null }
          ).time,
          state: this.disabled.has(c.id)
            ? "disabled"
            : stale || s.ok === null
              ? "unknown"
              : s.ok === 1
                ? "up"
                : s.active
                  ? "down"
                  : "pending",
          checkedAt: s.checked,
          responseMs: stale ? null : s.ms,
          reason: this.disabled.has(c.id)
            ? "Check disabled; historical observations retained"
            : stale
              ? "Monitoring unavailable; no recent observation"
              : s.reason,
          failures: s.failures,
          failureThreshold: c.failureThreshold,
          intervalSeconds: c.intervalSeconds,
          severity: c.severity,
          notify:
            c.notify &&
            !(
              this.config.minimumSeverity === "critical" &&
              c.severity !== "critical"
            ),
          activeIncident: s.active,
          summary: {
            windowSeconds: window,
            observedSeconds: observed,
            upSeconds: up,
            downSeconds: down,
            unknownSeconds: window - observed,
            availability:
              observed >= Math.max(3600, window * 0.8)
                ? (100 * up) / observed
                : null,
            since: samples[0]?.time ?? null,
          },
          trend,
        };
      });
    const incidentViews = (rows: IncidentView[]) =>
      rows.map((i) => ({
        ...i,
        source: this.db
          .prepare("SELECT incident FROM external_incidents WHERE incident=?")
          .get(i.id)
          ? ("watchdog" as const)
          : undefined,
        monitoringGap: Boolean(i.monitoringGap),
        notifications: this.db
          .prepare(
            "SELECT id,event,REPLACE(state,'external-','') AS state,attempts,lastAttempt,deliveredAt,error FROM notifications WHERE incident=? ORDER BY id",
          )
          .all(i.id) as unknown as NotificationView[],
      }));
    const incidents = incidentViews(
      this.db
        .prepare(
          "SELECT * FROM incidents WHERE id<? ORDER BY id DESC LIMIT 100",
        )
        .all(before) as unknown as IncidentView[],
    );
    const activeIncidents = incidentViews(
      this.db
        .prepare(
          "SELECT * FROM incidents WHERE endedAt IS NULL ORDER BY id DESC",
        )
        .all() as unknown as IncidentView[],
    );
    const counts = this.db
      .prepare(
        "SELECT SUM(state='pending') AS pending,SUM(state='failed') AS failed,SUM(state='delivered') AS delivered,MAX(deliveredAt) AS lastDeliveredAt FROM notifications",
      )
      .get() as {
      pending: number | null;
      failed: number | null;
      delivered: number | null;
      lastDeliveredAt: number | null;
    };
    return {
      generatedAt: now,
      healthy: this.healthy(now),
      checks,
      incidents,
      activeIncidents,
      notifications: {
        configured: !!this.delivery,
        provider: this.delivery?.provider || "SMTP not configured",
        minimumSeverity: this.config.minimumSeverity,
        pending: counts.pending || 0,
        failed: counts.failed || 0,
        delivered: counts.delivered || 0,
        lastDeliveredAt: counts.lastDeliveredAt,
      },
      retentionDays: this.preferences?.retention.sampleDays ?? 30,
    };
  }
}
