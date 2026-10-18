import type { AlertDetail, Metric, Window } from '../src/investigation-types.js';

export const DIAGNOSTICS: Record<string, [string, string]> = {
  'system.cpu': ['CPU', 'CPU utilization; includes I/O wait.'],
  'system.load': ['CPU', 'Runnable and uninterruptible tasks over 1, 5 and 15 minutes. Compare with core count.'],
  'system.cpu_some_pressure': ['CPU', 'PSI: time at least one task waited for CPU, averaged over 10/60/300 seconds.'],
  'system.memory_some_pressure': ['Memory', 'PSI: time at least one task stalled on memory.'],
  'system.memory_full_pressure': ['Memory', 'PSI: time all non-idle tasks stalled on memory.'],
  'mem.swap': ['Memory', 'Allocated swap capacity, in MiB.'],
  'mem.swapio': ['Memory', 'Swap input/output activity, in KiB/s.'],
  'mem.oom_kill': ['Memory', 'Kernel OOM kill rate, not a lifetime event count. Zoom in to investigate a spike.'],
  'system.io': ['Storage', 'Host disk read/write throughput.'],
  'system.io_some_pressure': ['Storage', 'PSI: time at least one task stalled on I/O.'],
  'system.io_full_pressure': ['Storage', 'PSI: time all non-idle tasks stalled on I/O.'],
  'disk.io': ['Storage', 'Device read/write throughput. Device layers may overlap; do not sum blindly.'],
  'disk.await': ['Storage', 'Average completion latency per operation, including queue time.'],
  'disk.inodes': ['Filesystems', 'Used, available and reserved filesystem inodes.'],
};
export function sensorGroup(labels: Record<string, string>) {
  const text = `${labels.driver} ${labels.chip_id} ${labels.subsystem}`;
  return /coretemp|k10temp|zenpower|cpu/i.test(text) ? 'CPU temperatures'
    : /nvme|drivetemp|smart|storage/i.test(text) ? 'Storage temperatures' : 'Other temperatures';
}
export function metricName(chart: { id: string; family: string; chart_labels?: Record<string, string> }) {
  const l = chart.chart_labels || {};
  return l.container_name || l.cgroup_name || l.mount_point || l.device ||
    (l.chip_id ? `${l.chip_id} · ${l.label && l.label !== '[none]' ? l.label : l.feature}` : chart.family || chart.id);
}
export function validateWindow(after: unknown, before: unknown, now = Math.floor(Date.now() / 1000)): Window {
  const a = Number(after), b = Number(before);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b > now + 60 || b - a < 30 || b - a > 31 * 86400)
    throw new Error('Choose a window between 30 seconds and 31 days, ending no later than now.');
  return { after: a, before: b };
}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
// The transition timestamp is a state-change time. It is not necessarily the
// beginning of an uninterrupted incident (e.g. WARNING -> CRITICAL).
export function activeAlert(a: any, charts: Record<string, Metric>): AlertDetail {
  return {
    id: String(a.gi), name: a.nm, summary: a.sum || a.nm, info: a.info || '',
    state: a.st, severity: a.st.toLowerCase(), resource: charts[a.ch]?.name || a.ch_n || a.ch,
    chart: a.ch, context: a.ctx, startedAt: number(a.tr_t), endedAt: null,
    duration: null, value: number(a.v), units: a.units || '', config: a.cfg || null,
    warning: null, critical: null, resolved: false,
  };
}
export function resolvedAlert(t: any, charts: Record<string, Metric>): AlertDetail | null {
  if (t.new?.status !== 'CLEAR' || !['WARNING', 'CRITICAL'].includes(t.old?.status)) return null;
  const duration = number(t.old.raised_duration) ?? number(t.old.duration);
  return {
    id: t.transition_id, name: t.alert, summary: t.summary || t.alert, info: t.info || '',
    state: 'CLEAR', severity: t.old.status.toLowerCase(), resource: charts[t.instance]?.name || t.instance_n || t.instance,
    chart: t.instance, context: t.context, startedAt: duration === null ? null : t.when - duration,
    endedAt: number(t.when), duration, value: number(t.old.value), units: t.units || '',
    config: t.config_hash_id || null, warning: null, critical: null, resolved: true,
  };
}
