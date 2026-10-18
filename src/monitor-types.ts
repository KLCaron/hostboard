export type CheckState = 'up' | 'down' | 'pending' | 'unknown' | 'disabled';
export interface CheckView {
  generation?: number;
  id: string; name: string; hostId: string; container?: string; type: 'http' | 'tcp';
  group?: 'Applications' | 'Infrastructure'; lastSuccessfulAt?: number | null;
  state: CheckState; checkedAt: number | null; responseMs: number | null; reason: string;
  failures: number; failureThreshold: number; intervalSeconds: number; severity: string;
  notify: boolean; activeIncident: number | null;
  summary: { windowSeconds: number; observedSeconds: number; upSeconds: number; downSeconds: number; unknownSeconds: number; availability: number | null; since: number | null };
  trend: { time: number; responseMs: number | null; ok: boolean | null }[];
}
export interface NotificationView { id: number; event: string; state: string; attempts: number; lastAttempt: number | null; deliveredAt: number | null; error: string | null }
export interface IncidentView {
  id: number; checkId: string; name: string; hostId: string; severity: string;
  startedAt: number; detectedAt: number; endedAt: number | null; reason: string; lastReason: string;
  responseMs: number | null; resolution: string | null; monitoringGap: boolean;
  notifications: NotificationView[];
  source?: 'watchdog';
}
export interface MonitorView {
  generatedAt: number; healthy: boolean; checks: CheckView[]; incidents: IncidentView[];
  activeIncidents?: IncidentView[];
  notifications: { configured: boolean; provider: string; minimumSeverity: string; pending: number; failed: number; delivered: number; lastDeliveredAt: number | null };
  retentionDays: number;
}
