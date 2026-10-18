// SPDX-License-Identifier: AGPL-3.0-only
import type { LogContext } from "./log-types";
import { rangeSeconds } from "./RangeSelector";
import type { Range } from "./types";
export type LogWindow = { after: string; before: string };
export function logLink(
  context: LogContext,
  window?: LogWindow,
  destination = "logs",
  alertId?: string,
) {
  const p = new URLSearchParams({ host: context.hostId });
  if (context.incidentId) p.set("incident", String(context.incidentId));
  else if (context.serviceId) {
    p.set("service", context.serviceId);
    if (context.generation) p.set("generation", String(context.generation));
  } else if (context.container) p.set("container", context.container);
  if (window) {
    p.set("after", window.after);
    p.set("before", window.before);
  }
  if (alertId) p.set("alert", alertId);
  if (destination === "settings") p.set("tab", "logs");
  return `#${destination}?${p}`;
}
export function parseLogRoute(hash: string, now = Date.now()) {
  const p = new URLSearchParams(hash.split("?")[1] ?? "");
  let invalid = false;
  const text = (key: string, max = 200) => {
    const v = p.get(key) ?? "";
    if (v.length > max || /[\x00-\x1f\x7f]/.test(v)) {
      invalid = true;
      return "";
    }
    return v;
  };
  const id = (key: string) => {
    const s = p.get(key);
    if (s === null) return undefined;
    const n = Number(s);
    if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(n)) {
      invalid = true;
      return undefined;
    }
    return n;
  };
  const host = text("host", 64),
    source = text("source", 80),
    serviceId = text("service"),
    container = text("container"),
    incidentId = id("incident"),
    generation = id("generation");
  if (host && !/^[a-zA-Z0-9_-]+$/.test(host)) invalid = true;
  if (serviceId && container) invalid = true;
  let window: LogWindow | undefined;
  if (p.has("after") || p.has("before")) {
    const a = p.get("after") ?? "",
      b = p.get("before") ?? "",
      after = Date.parse(a),
      before = Date.parse(b);
    if (
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(a) ||
      !/^\d{4}-\d\d-\d\dT.*Z$/.test(b) ||
      !Number.isFinite(after) ||
      !Number.isFinite(before) ||
      after < 0 ||
      before <= after ||
      before - after > 86400000 ||
      before > now + 60000
    )
      invalid = true;
    else window = { after: a, before: b };
  }
  const preset = p.get("range");
  const range: Range | "custom" | undefined =
    preset &&
    Object.hasOwn(rangeSeconds, preset) &&
    (!window ||
      Math.abs(
        Date.parse(window.before) -
          Date.parse(window.after) -
          rangeSeconds[preset as Range] * 1000,
      ) < 2)
      ? (preset as Range)
      : window
        ? "custom"
        : undefined;
  const alert = text("alert");
  return {
    alert,
    host,
    source,
    context: {
      hostId: host,
      ...(incidentId
        ? { incidentId }
        : serviceId
          ? { serviceId, generation }
          : container
            ? { container }
            : {}),
    } as LogContext,
    window,
    range,
    invalid,
  };
}
export function replaceLogState(patch: Record<string, string | undefined>) {
  if (!location.hash.startsWith("#logs")) return;
  const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
  for (const [k, v] of Object.entries(patch))
    v === undefined ? p.delete(k) : p.set(k, v);
  history.replaceState(null, "", `#logs?${p}`);
}
