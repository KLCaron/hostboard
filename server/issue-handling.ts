import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorization, type AdminConfig } from './admin.js';
import type { Configuration } from './settings.js';
import type { Monitor } from './monitor.js';
import type { Servers } from './servers.js';
import type { AlertDetail, AlertHistory } from '../src/investigation-types.js';
import type { Host } from '../src/types.js';
import type { IncidentView, MonitorView } from '../src/monitor-types.js';
import type { IssueHandling } from '../src/issue-handling-types.js';

type Target = { kind: 'metric' | 'availability'; hostId: string; identity: string; name: string; scope: string; occurrence: string; severity: string };
type Rule = IssueHandling & { scope: string; occurrence: string; identity: string; severity: string };
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const Input = z.object({
  revision: z.number().int().positive(), kind: z.enum(['metric', 'availability']),
  hostId: z.string().min(1).max(64), alertId: z.string().min(1).max(160).optional(),
  incidentId: z.number().int().positive().optional(),
  mode: z.enum(['acknowledged', 'snoozed', 'ignored']),
  durationSeconds: z.union([z.literal(3600), z.literal(86400), z.literal(604800)]).optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((v, c) => {
  if ((v.kind === 'metric' ? !v.alertId || !!v.incidentId : !v.incidentId || !!v.alertId) ||
      (v.mode === 'snoozed') !== (v.durationSeconds !== undefined))
    c.addIssue({code: 'custom', message: 'Choose one current issue and a duration only for snoozing'});
});
export class IssueHandlingStore {
  constructor(readonly store: Configuration, readonly identity: (hostId: string) => string | null, readonly clock = () => Date.now() / 1000) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS issue_handling(id TEXT PRIMARY KEY,value TEXT NOT NULL)`);
  }
  rules(): Rule[] { return (this.store.db.prepare('SELECT value FROM issue_handling').all() as {value: string}[]).map(r => JSON.parse(r.value)); }
  view() {
    return {revision: this.store.revision(), rules: this.rules().map(({scope: _s, occurrence: _o, identity: _i, severity: _v, ...r}) => r)};
  }
  metric(hostId: string, a: AlertDetail): Target | null {
    const identity = this.identity(hostId);
    return identity ? {kind: 'metric', hostId, identity, name: a.summary,
      scope: hash(['metric', identity, hostId, a.name, a.chart, a.context, a.config, a.warning, a.critical]), occurrence: a.id, severity: a.severity} : null;
  }
  incident(i: IncidentView): Target | null {
    const identity = this.identity(i.hostId);
    return identity ? {kind: 'availability', hostId: i.hostId, identity, name: i.name,
      scope: hash(['availability', identity, i.hostId, i.checkId, i.generation ?? 1]), occurrence: String(i.id), severity: i.severity} : null;
  }
  matching(target: Target | null): Rule | undefined {
    if (!target) return;
    const row = this.store.db.prepare('SELECT value FROM issue_handling WHERE id=?').get(target.scope) as {value: string} | undefined;
    const r: Rule | undefined = row ? JSON.parse(row.value) : undefined;
    if (!r || r.revokedAt !== null || (r.until !== null && r.until <= this.clock()) ||
        (r.mode === 'acknowledged' && r.occurrence !== target.occurrence) ||
        (target.severity === 'critical' && r.severity !== 'critical')) return;
    return r;
  }
  save(target: Target, input: Pick<z.infer<typeof Input>, 'revision' | 'mode' | 'durationSeconds' | 'reason'>, actor: string) {
    this.store.atomic(() => {
      if (input.revision !== this.store.revision()) throw Object.assign(Error('Configuration changed. Reload before saving.'), {status: 409});
      if (this.identity(target.hostId) !== target.identity) throw Error('Server identity changed; reload the issue');
      const exists = this.store.db.prepare('SELECT id FROM issue_handling WHERE id=?').get(target.scope);
      if (!exists && this.rules().length >= 500) throw Error('Maximum of 500 handling rules reached');
      const r: Rule = {...target, id: target.scope, mode: input.mode, reason: input.reason, actor,
        createdAt: this.clock(), until: input.mode === 'snoozed' ? this.clock() + input.durationSeconds! : null, revokedAt: null};
      this.store.db.prepare('INSERT INTO issue_handling VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(r.id, JSON.stringify(r));
      this.store.bump();
      this.store.audit(actor, `Issue ${input.mode}: ${target.kind} ${target.hostId} ${target.name}; ${input.reason}`);
    });
  }
  restore(id: string, revision: number, actor: string) {
    this.store.atomic(() => {
      if (revision !== this.store.revision()) throw Object.assign(Error('Configuration changed. Reload before saving.'), {status: 409});
      const row = this.store.db.prepare('SELECT value FROM issue_handling WHERE id=?').get(id) as {value: string} | undefined;
      if (!row) throw Object.assign(Error('Unknown handling rule'), {status: 404});
      const r: Rule = JSON.parse(row.value); r.revokedAt = this.clock();
      this.store.db.prepare('UPDATE issue_handling SET value=? WHERE id=?').run(JSON.stringify(r), id);
      this.store.bump(); this.store.audit(actor, `Restored issue ${r.kind} ${r.hostId} ${r.name}`);
    });
  }
  alerts(hostId: string, h: AlertHistory): AlertHistory {
    if (h.errors.length) return h;
    return {...h, active: h.active.map(a => ({...a, handling: this.matching(this.metric(hostId, a))})),
      resolved: h.resolved.map(a => ({...a, handling: this.matching(this.metric(hostId, a))}))};
  }
  monitor(v: MonitorView): MonitorView {
    const decorate = (i: IncidentView) => ({...i, handling: this.matching(this.incident(i))});
    const activeIncidents = v.activeIncidents?.map(decorate);
    return {...v, incidents: v.incidents.map(decorate), activeIncidents,
      checks: v.checks.map(c => ({...c, handling: activeIncidents?.find(i => i.id === c.activeIncident)?.handling}))};
  }
  async host(h: Host, details: () => Promise<AlertHistory>): Promise<Host> {
    if (!h.alerts?.length || !this.rules().some(r => r.kind === 'metric' && r.hostId === h.id && !r.revokedAt && (!r.until || r.until > this.clock()))) return h;
    try {
      const d = this.alerts(h.id, await details());
      if (d.errors.length) throw Error();
      const handled = d.active.filter(a => a.handling), visible = d.active.filter(a => !a.handling);
      // Only adjust counts when full instance detail agrees with the summary.
      if (d.active.length !== h.alerts.reduce((n, a) => n + a.count, 0)) throw Error();
      return {...h, handledAlerts: handled.length, alerts: h.alerts.map(a => ({...a, count: visible.filter(v => v.name === a.name).length})).filter(a => a.count > 0)};
    } catch { return {...h, warnings: [...h.warnings, 'Alert handling could not be verified; all source alerts remain visible']}; }
  }
}
export function issueHandlingAPI(handling: IssueHandlingStore, registry: Servers, monitor: Monitor, admin: AdminConfig, auth = authorization(admin)) {
  const r = Router();
  r.get('/issues/handling', (_req, res) => res.json(handling.view()));
  r.use('/admin/issues', auth.guard, express.json({limit: '8kb'}));
  r.post('/admin/issues/handling', async (req, res) => {
    const input = Input.parse(req.body);
    let target: Target | null;
    if (input.kind === 'metric') {
      const host = await registry.current(input.hostId), agent = registry.agent(input.hostId);
      if (!agent || host.status !== 'online') throw Error('Fresh online alert coverage is required');
      const details = await agent.alertDetails();
      if (details.errors.length) throw Error('Alert coverage is incomplete; retry after collection recovers');
      const alert = details.active.find(a => a.id === input.alertId);
      if (!alert) throw Error('This alert is no longer active; reload the issue');
      target = handling.metric(input.hostId, alert);
    } else {
      const incident = monitor.view(undefined, undefined, false).activeIncidents?.find(i => i.id === input.incidentId && i.hostId === input.hostId);
      if (!incident) throw Error('This incident is no longer active; reload the issue');
      target = handling.incident(incident);
    }
    if (!target) throw Error('A pinned server identity is required');
    handling.save(target, input, res.locals.actor); res.json(handling.view());
  });
  r.post('/admin/issues/handling/:id/restore', (req, res) => {
    const {revision} = z.object({revision: z.number().int().positive()}).strict().parse(req.body);
    handling.restore(req.params.id, revision, res.locals.actor); res.json(handling.view());
  });
  r.use(((e, _req, res, _next) => res.status(e.status || 400).json({error: e instanceof z.ZodError ? 'Invalid issue action' : e.message || 'Issue action failed'})) as express.ErrorRequestHandler);
  return r;
}
