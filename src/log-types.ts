// SPDX-License-Identifier: AGPL-3.0-only
export interface LogCursor {
  containerId: string;
  time: string;
  skip: number;
}
export interface LogEntry {
  time: string;
  stream: "stdout" | "stderr" | "combined";
  text: string;
  truncated: boolean;
}
export interface LogSource {
  id: string;
  hostId: string;
  name: string;
  available: boolean;
  error?: string;
  containerId?: string;
  containerName?: string;
  created?: string;
  driver?: string;
  tty?: boolean;
}
export interface LogResult {
  containerId: string;
  containerName: string;
  created: string;
  driver: string;
  tty: boolean;
  entries: LogEntry[];
  truncated: boolean;
  nextCursor: LogCursor | null;
  resumeCursor: LogCursor | null;
  scannedBytes: number;
  notice: string;
  incomplete: boolean;
}
export interface LogQuery {
  source: string;
  after: string;
  before: string;
  search?: string;
  caseSensitive?: boolean;
  stream?: "all" | LogEntry["stream"];
  cursor?: LogCursor;
}
export interface LogContext {
  hostId: string;
  serviceId?: string;
  generation?: number;
  container?: string;
  incidentId?: number;
}
export function incidentLogWindow(
  start: number,
  end: number | null,
  now = Date.now() / 1000,
) {
  const after = Math.max(0, start - 900);
  // Start with the onset. Long incidents can be explored in additional daily windows.
  return {
    after: new Date(after * 1000).toISOString(),
    before: new Date(
      Math.min(now, after + 86400, (end ?? start) + 900) * 1000,
    ).toISOString(),
  };
}
