export interface Metric {
  id: string;
  context: string;
  name: string;
  units: string;
  group: string;
  description: string;
}
export interface Diagnostic extends Metric {
  values: Record<string, number | null>;
}
export interface AlertDetail {
  handling?: import('./issue-handling-types.js').IssueHandling;
  id: string;
  name: string;
  summary: string;
  info: string;
  state: string;
  severity: string;
  resource: string;
  chart: string;
  context: string;
  startedAt: number | null;
  endedAt: number | null;
  duration: number | null;
  value: number | null;
  units: string;
  config: string | null;
  warning: string | null;
  critical: string | null;
  resolved: boolean;
}
export interface AlertHistory {
  active: AlertDetail[];
  resolved: AlertDetail[];
  errors: string[];
  fetchedAt: string;
}
export interface Window {
  after: number;
  before: number;
}
export interface MetricHistory {
  metric: Metric;
  window: Window;
  points: { time: number; [key: string]: number | null }[];
  dimensions: string[];
  retention: { first: number | null; last: number | null; interval: number | null };
  errors: string[];
  fetchedAt: string;
}
