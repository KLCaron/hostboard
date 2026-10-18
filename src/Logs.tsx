// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  LogContext,
  LogCursor,
  LogEntry,
  LogQuery,
  LogResult,
  LogSource,
} from "./log-types";
import type { Host, Range } from "./types";
import { readPreference, savePreference } from "./preferences";
import { RangeSelector, rangeSeconds } from "./RangeSelector";
import {
  logLink,
  parseLogRoute,
  replaceLogState,
  type LogWindow,
} from "./log-navigation";
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Log source unavailable";
export async function logApi(
  route: string,
  body?: unknown,
  signal?: AbortSignal,
  method = "POST",
) {
  const r = await fetch(`/api/admin/logs/${route}`, {
    method: body === undefined ? "GET" : method,
    signal,
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Hostboard-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || "Log request failed");
  return result;
}
const api = logApi;
const localDate = (value: string) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
};
const iso = (value: string) => new Date(value).toISOString();
export function LogSection({
  context,
  initialWindow,
}: {
  context: LogContext;
  initialWindow?: LogWindow;
}) {
  return (
    <div className="log-section">
      <a className="action-link" href={logLink(context, initialWindow)}>
        {context.incidentId ? "View related logs" : "View logs"} →
      </a>
    </div>
  );
}
export function LogsPage({ hosts }: { hosts: Host[] }) {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  const route = parseLogRoute(hash);
  const remembered = readPreference(
    "logHost",
    "",
    (v) => typeof v === "string",
  );
  const host =
    route.host ||
    (hosts.some((h) => h.id === remembered) ? remembered : hosts[0]?.id) ||
    "";
  const validHost = hosts.some((h) => h.id === host);
  const hostControl = (
    <label className="log-source-label">
      Host
      <select
        aria-label="Log host"
        value={host}
        onChange={(e) => {
          savePreference("logHost", e.target.value);
          location.hash = logLink({ hostId: e.target.value });
        }}
      >
        {!validHost && <option value={host}>{host || "Loading hosts…"}</option>}
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name} · {h.status}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="monitor-panel logs-page" aria-label="Centralized logs">
      <p className="detail-description">
        Retained Docker logs · administrator access · no permanent log storage.
      </p>
      {route.alert && validHost && !route.invalid && (
        <p className="notice">
          Metric issue investigation ·{" "}
          <a
            className="text-link"
            href={`#alert=${host}:${encodeURIComponent(route.alert)}`}
          >
            Return to metric issue →
          </a>
        </p>
      )}
      {route.invalid ? (
        <>
          {hostControl}
          <p role="alert" className="notice danger">
            Invalid log link. Choose a host to start a new investigation.
          </p>
        </>
      ) : host && !validHost && hosts.length ? (
        <>
          {hostControl}
          <p role="alert" className="notice danger">
            Unknown host. Choose a configured host.
          </p>
        </>
      ) : validHost ? (
        <LogPanel
          key={hash + host}
          context={{ ...route.context, hostId: host }}
          initialWindow={route.window}
          initialSource={route.source}
          initialRange={route.range}
          hostControl={hostControl}
        />
      ) : (
        <p role="status">Loading hosts…</p>
      )}
    </section>
  );
}
function LogPanel({
  context,
  initialWindow,
  initialSource,
  initialRange,
  hostControl,
}: {
  hostControl: ReactNode;
  context: LogContext;
  initialWindow?: LogWindow;
  initialSource?: string;
  initialRange?: Range | "custom";
}) {
  const [admin, setAdmin] = useState<boolean>(),
    [sources, setSources] = useState<LogSource[]>([]),
    [mapped, setMapped] = useState<string[]>([]),
    [source, setSource] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const hasContext = !!(
    context.serviceId ||
    context.container ||
    context.incidentId
  );
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      const session = await (
        await fetch("/api/session", { signal: controller.signal })
      ).json();
      if (!active) return;
      setAdmin(!!session.admin);
      if (!session.admin) return;
      const catalog = await api(
        `sources/${context.hostId}`,
        undefined,
        controller.signal,
      );
      if (!active) return;
      setSources(catalog.sources);
      const association = hasContext
        ? await api("context", context, controller.signal)
        : { sources: [] };
      if (!active) return;
      setMapped(association.sources);
      const choices: LogSource[] = hasContext
        ? catalog.sources.filter((s: LogSource) =>
            association.sources.includes(s.id),
          )
        : catalog.sources;
      const saved = hasContext
        ? ""
        : readPreference(
            `logSource:${context.hostId}`,
            "",
            (v) => typeof v === "string",
          );
      const chosen =
        initialSource || (choices.length === 1 ? choices[0].id : saved);
      if (choices.some((s) => s.id === chosen)) {
        setSource(chosen);
        savePreference(`logSource:${context.hostId}`, chosen);
        replaceLogState({ host: context.hostId, source: chosen });
      } else if (initialSource)
        setError(
          "The linked source is not approved for this context. Choose an available source.",
        );
    })()
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [JSON.stringify(context)]);
  if (loading)
    return (
      <>
        {hostControl}
        <p role="status">Loading approved log sources…</p>
      </>
    );
  if (admin === false)
    return (
      <>
        {hostControl}
        <p className="notice">
          Log contents require an authorized administrator. Sign in as a local
          administrator or use an allowlisted Cloudflare Access identity.
        </p>
      </>
    );
  const choices = hasContext
    ? sources.filter((s) => mapped.includes(s.id))
    : sources;
  const chosen = sources.find((s) => s.id === source);
  const currentRoute = parseLogRoute(location.hash);
  return (
    <div className="log-panel">
      {context.incidentId && (
        <p className="notice">
          Investigating incident #{context.incidentId} ·{" "}
          {initialWindow
            ? `${new Date(initialWindow.after).toLocaleString()} – ${new Date(initialWindow.before).toLocaleString()}`
            : "Choose a retained time window"}
          .{" "}
          <a className="text-link" href={`#incident=${context.incidentId}`}>
            Return to incident →
          </a>
        </p>
      )}
      <div className="log-source-strip">
        {hostControl}
        {!!choices.length && (
          <label className="log-source-label">
            Log source
            <select
              aria-label="Log source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                savePreference(`logSource:${context.hostId}`, e.target.value);
                replaceLogState({
                  host: context.hostId,
                  source: e.target.value || undefined,
                });
              }}
            >
              <option value="">Choose a source…</option>
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.containerName ?? s.id}
                  {!s.available ? " · unavailable" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      {!sources.length && !error && (
        <p className="notice">
          No approved log sources are available. An operator must enable the
          optional Docker log adapter and approve sources on this host.
          File-only application logs are not supported.
        </p>
      )}
      {hasContext && (
        <p className="small">
          {mapped.length
            ? `Confirmed sources for ${context.serviceId || context.container || "this incident"}.`
            : "No confirmed log source association. Names alone do not establish container identity."}{" "}
          <a
            className="text-link"
            href={logLink(context, undefined, "settings")}
          >
            Configure source associations →
          </a>{" "}
          ·{" "}
          <a className="text-link" href={logLink({ hostId: context.hostId })}>
            Browse approved host sources →
          </a>
        </p>
      )}
      {mapped.some((id) => !sources.some((s) => s.id === id)) && (
        <p className="notice">
          A previously associated source is no longer approved. Review the
          source associations in Settings.
        </p>
      )}
      {chosen && (
        <details className="source-identity">
          <summary>
            {chosen.available ? "Available" : "Unavailable"} ·{" "}
            {chosen.containerName ?? chosen.id} · Source details
          </summary>
          <p>
            {context.hostId} / {chosen.id} ·{" "}
            {chosen.containerId ?? chosen.error} · {chosen.driver}
            {chosen.created &&
              ` · Created ${new Date(chosen.created).toLocaleString()}`}
          </p>
          {context.incidentId && (
            <p>
              The current container may differ from the one present during an
              older incident. Associations do not establish causality or prove
              retained historical coverage.
            </p>
          )}
        </details>
      )}
      {source &&
        (chosen?.available ? (
          <LogExplorer
            key={context.hostId + source}
            hostId={context.hostId}
            source={source}
            initialWindow={currentRoute.window ?? initialWindow}
            initialRange={currentRoute.range ?? initialRange}
            incidentId={context.incidentId}
          />
        ) : (
          <p className="notice">
            Logs are unavailable for this source. Its association is preserved;
            an operator must check its approved container identity and adapter.
          </p>
        ))}
    </div>
  );
}
function level(text: string) {
  try {
    const value = JSON.parse(text);
    const l = String(value?.level ?? value?.severity ?? "").toLowerCase();
    return ["error", "fatal", "critical"].includes(l)
      ? "error"
      : ["warn", "warning"].includes(l)
        ? "warning"
        : "";
  } catch {
    return /^\s*(?:\[[^\]]{1,80}\]\s*)?(?:ERROR|FATAL|CRITICAL)\b/.test(text)
      ? "error"
      : /^\s*(?:\[[^\]]{1,80}\]\s*)?WARN(?:ING)?\b/.test(text)
        ? "warning"
        : "";
  }
}
function Highlight({
  text,
  query,
  sensitive,
}: {
  text: string;
  query: string;
  sensitive: boolean;
}) {
  if (!query) return <>{text}</>;
  const hay = sensitive ? text : text.toLowerCase(),
    needle = sensitive ? query : query.toLowerCase();
  let from = 0,
    index = 0;
  const pieces = [];
  while ((index = hay.indexOf(needle, from)) >= 0 && pieces.length < 1000) {
    pieces.push(
      text.slice(from, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    from = index + query.length;
  }
  pieces.push(text.slice(from));
  return <>{pieces}</>;
}
function Structured({ text }: { text: string }) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (
      <details className="log-json">
        <summary>JSON fields</summary>
        <pre>{JSON.stringify(v, null, 2)}</pre>
      </details>
    ) : null;
  } catch {
    return null;
  }
}
export function LogExplorer({
  hostId,
  source,
  initialWindow,
  incidentId,
  initialRange,
}: {
  hostId: string;
  source: string;
  initialWindow?: { after: string; before: string };
  incidentId?: number;
  initialRange?: Range | "custom";
}) {
  const savedRange = readPreference<Range>(
    "logRange",
    "15m",
    (v) => typeof v === "string" && Object.hasOwn(rangeSeconds, v),
  );
  const initial = useRef(
    initialWindow ??
      (() => {
        const before = Date.now();
        return {
          after: new Date(
            before - rangeSeconds[savedRange] * 1000,
          ).toISOString(),
          before: new Date(before).toISOString(),
        };
      })(),
  ).current;
  const [window, setWindow] = useState(initial),
    [range, setRange] = useState<Range | "custom">(
      initialRange ?? (initialWindow ? "custom" : savedRange),
    ),
    [dirty, setDirty] = useState(false),
    [showTimes, setShowTimes] = useState(!!initialWindow),
    [followEnd, setFollowEnd] = useState<string>(),
    [wrap, setWrap] = useState(() =>
      readPreference("logWrap", true, (v) => typeof v === "boolean"),
    ),
    [zone, setZone] = useState(() =>
      readPreference("logZone", "local", (v) => v === "local" || v === "utc"),
    ),
    [draftAfter, setDraftAfter] = useState(() => localDate(initial.after)),
    [draftBefore, setDraftBefore] = useState(() => localDate(initial.before)),
    [search, setSearch] = useState(""),
    [sensitive, setSensitive] = useState(false),
    [stream, setStream] = useState<LogQuery["stream"]>("all"),
    [filter, setFilter] = useState({
      search: "",
      caseSensitive: false,
      stream: "all" as LogQuery["stream"],
    }),
    [entries, setEntries] = useState<LogEntry[]>([]),
    [result, setResult] = useState<LogResult>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState(false),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<Set<number>>(new Set()),
    [message, setMessage] = useState(""),
    [evicted, setEvicted] = useState(false);
  const startInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null),
    cursor = useRef<LogCursor | null>(null),
    generation = useRef(0),
    inFlight = useRef(false),
    viewport = useRef<HTMLDivElement>(null);
  const windowKey = JSON.stringify([window, filter]);
  useEffect(() => {
    replaceLogState({ ...window, range });
  }, [windowKey, range]);
  async function load(append = false, follow = false) {
    if (inFlight.current) return;
    const turn = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const before = follow
        ? new Date().toISOString()
        : (followEnd ?? window.before);
      const value: LogResult = await api(
        `query/${hostId}`,
        {
          source,
          after: window.after,
          before,
          ...filter,
          ...(append && cursor.current ? { cursor: cursor.current } : {}),
        },
        abort.signal,
      );
      if (turn !== generation.current) return;
      cursor.current = value.nextCursor ?? value.resumeCursor;
      setResult(value);
      if (follow) {
        setFollowEnd(before);
        replaceLogState({ before, range: "custom" });
        if (!dirty) setDraftBefore(localDate(before));
      }
      setEntries((old) => {
        const all = append ? [...old, ...value.entries] : value.entries;
        let bytes = 0,
          start = all.length;
        while (
          start > 0 &&
          all.length - start < 2000 &&
          bytes + all[start - 1].text.length <= 1000000
        ) {
          start--;
          bytes += all[start].text.length;
        }
        if (start > 0) setEvicted(true);
        return all.slice(start);
      });
      setSelected(new Set());
      if (value.incomplete) {
        setLive(false);
        setError(
          "The scan was incomplete. Narrow the time range to retrieve a complete, pageable result.",
        );
      }
      // With no returned records, advance only through a fully scanned range.
      if (follow && Date.parse(before) - Date.parse(window.after) >= 86300000) {
        setLive(false);
        setMessage(
          "Live session reached its 24-hour window. Choose a new range to continue.",
        );
      }
    } catch (e) {
      if (turn === generation.current && !abort.signal.aborted) {
        setError(errorText(e));
        setLive(false);
      }
    } finally {
      if (turn === generation.current) {
        setBusy(false);
        inFlight.current = false;
      }
    }
  }
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    inFlight.current = false;
    cursor.current = null;
    setEntries([]);
    setSelected(new Set());
    setResult(undefined);
    setEvicted(false);
    setMessage("");
    void load();
    return () => {
      generation.current++;
      controller.current?.abort();
      inFlight.current = false;
    };
  }, [windowKey, revision]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(true, true), 3000);
    return () => clearInterval(timer);
  }, [live, windowKey, followEnd]);
  useEffect(() => {
    if (live)
      viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [entries, live]);
  function stop() {
    setLive(false);
    generation.current++;
    controller.current?.abort();
    inFlight.current = false;
    setBusy(false);
  }
  const text = () =>
    [...selected]
      .sort((a, b) => a - b)
      .filter((i) => entries[i])
      .map(
        (i) => `${entries[i].time} [${entries[i].stream}] ${entries[i].text}`,
      )
      .join("\n");
  const preset = (selected: Range) => {
    const seconds = rangeSeconds[selected];
    setShowTimes(false);
    setFollowEnd(undefined);
    setRange(selected);
    savePreference("logRange", selected);
    setDirty(false);
    stop();
    const end = Date.now(),
      w = {
        after: new Date(end - seconds * 1000).toISOString(),
        before: new Date(end).toISOString(),
      };
    setWindow(w);
    setDraftAfter(localDate(w.after));
    setDraftBefore(localDate(w.before));
  };
  return (
    <section className="log-explorer" aria-label="Log explorer">
      <RangeSelector
        label="Log time presets"
        value={range}
        custom
        onChange={(r) => {
          if (r === "custom") {
            stop();
            setRange(r);
            setShowTimes(true);
            setTimeout(() => startInput.current?.focus(), 0);
          } else preset(r);
        }}
      />
      <form
        className="log-controls"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const w = { after: iso(draftAfter), before: iso(draftBefore) };
            if (
              Date.parse(w.after) >= Date.parse(w.before) ||
              Date.parse(w.before) - Date.parse(w.after) > 86400000 ||
              Date.parse(w.before) > Date.now() + 60000
            )
              throw Error("Choose a range of at most 24 hours");
            stop();
            setWindow(
              dirty ? w : { ...window, before: followEnd ?? window.before },
            );
            setFollowEnd(undefined);
            setDirty(false);
            setFilter({ search, caseSensitive: sensitive, stream });
            setRevision((v) => v + 1);
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        <details
          className="log-time-fields"
          open={showTimes}
          onToggle={(e) => setShowTimes(e.currentTarget.open)}
        >
          <summary>Custom timestamps (local time)</summary>
          <div className="log-time-inputs">
            <label>
              Start (local time)
              <input
                ref={startInput}
                aria-label="Log start"
                type="datetime-local"
                step="1"
                required
                value={draftAfter}
                onChange={(e) => {
                  stop();
                  setRange("custom");
                  setDirty(true);
                  setDraftAfter(e.target.value);
                }}
              />
            </label>
            <label>
              End (local time)
              <input
                aria-label="Log end"
                type="datetime-local"
                step="1"
                required
                value={draftBefore}
                onChange={(e) => {
                  stop();
                  setRange("custom");
                  setDirty(true);
                  setDraftBefore(e.target.value);
                }}
              />
            </label>
          </div>
        </details>
        <label>
          Text search
          <input
            aria-label="Search logs"
            type="search"
            maxLength={256}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Plain text substring…"
          />
        </label>
        <label className="log-checkbox">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => setSensitive(e.target.checked)}
          />
          Case sensitive
        </label>
        <label>
          Stream
          <select
            aria-label="Log stream"
            value={stream}
            onChange={(e) => setStream(e.target.value as LogQuery["stream"])}
          >
            <option value="all">All streams</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
            <option value="combined">Combined (TTY)</option>
          </select>
        </label>
        <button type="submit">Show logs</button>
      </form>
      <div className="log-toolbar">
        <button
          onClick={() => {
            if (live || busy) stop();
            else if (
              Date.now() - Date.parse(window.after) >= 86300000 ||
              Date.now() - Date.parse(followEnd ?? window.before) > 900000
            ) {
              preset("15m");
              setRange("custom");
              setLive(true);
              setMessage(
                "Live tail opened the last 15 minutes. Use the incident link to return to its historical context.",
              );
            } else {
              setRange("custom");
              setLive(true);
              void load(true, true);
            }
          }}
        >
          {live
            ? "Pause live tail"
            : busy
              ? "Cancel query"
              : "Resume live tail"}
        </button>
        <span className={live ? "check-state up" : "muted"} role="status">
          {live
            ? "Live · every 3 seconds"
            : busy
              ? "Loading bounded log page…"
              : "Paused · historical range"}
        </span>
        {!live && (
          <button
            disabled={busy || !result?.nextCursor}
            onClick={() => void load(true)}
          >
            Load next page
          </button>
        )}
        <button
          disabled={busy}
          onClick={() => {
            stop();
            setRevision((v) => v + 1);
          }}
        >
          Reload range
        </button>
      </div>
      {incidentId && (
        <p className="small">
          <a className="text-link" href={`#incident=${incidentId}`}>
            Incident #{incidentId} ↗
          </a>{" "}
          ·{" "}
          <a
            className="text-link"
            href={`#host=${hostId}?after=${Math.floor(Date.parse(window.after) / 1000)}&before=${Math.floor(Date.parse(followEnd ?? window.before) / 1000)}&incident=${incidentId}`}
          >
            Host metrics →
          </a>
        </p>
      )}
      {result?.tty && (
        <p className="notice">
          TTY combines stdout/stderr; separate stream filtering is unavailable.
        </p>
      )}
      {result && Date.parse(result.created) > Date.parse(window.after) && (
        <p className="notice">
          This container was created at{" "}
          {new Date(result.created).toLocaleString()}. Earlier entries from a
          previous container are unavailable through this source.
        </p>
      )}
      {error && (
        <p role="alert" className="notice danger">
          {error}
        </p>
      )}
      {result?.truncated && (
        <p className="notice">
          Partial results: a line, byte, scan or query-time limit was reached.{" "}
          {result.nextCursor
            ? "Load the next page or narrow the range."
            : "Narrow the range and retry."}
        </p>
      )}
      {evicted && (
        <p className="notice">
          Browser buffer limited to 2,000 entries / 1 million characters.
          Earlier displayed entries were removed; use a historical range to
          inspect them again.
        </p>
      )}
      <div className="log-display-options">
        <label>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => {
              setWrap(e.target.checked);
              savePreference("logWrap", e.target.checked);
            }}
          />{" "}
          Wrap lines
        </label>
        <label>
          Timestamp display{" "}
          <select
            aria-label="Timestamp display"
            value={zone}
            onChange={(e) => {
              setZone(e.target.value);
              savePreference("logZone", e.target.value);
            }}
          >
            <option value="local">Local time</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      {(dirty ||
        search !== filter.search ||
        sensitive !== filter.caseSensitive ||
        stream !== filter.stream) && (
        <p className="notice" role="status">
          Controls edited. Choose Show logs to apply them; results below still
          use the last queried window.
        </p>
      )}
      <p className="small muted">
        Query window: {new Date(window.after).toLocaleString()} —{" "}
        {live
          ? "now (live)"
          : new Date(followEnd ?? window.before).toLocaleString()}
      </p>
      <details className="log-export">
        <summary>
          {entries.length} displayed · {selected.size} selected · Selection &
          export
        </summary>
        <div className="log-selection">
          <span>
            {entries.length} displayed · {selected.size} selected
          </span>
          <button
            disabled={!entries.length || live}
            onClick={() => setSelected(new Set(entries.map((_, i) => i)))}
          >
            Select displayed
          </button>
          <button
            disabled={!selected.size}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
          <button
            disabled={!selected.size || live}
            onClick={() => {
              void navigator.clipboard
                .writeText(text())
                .then(() => setMessage("Selected entries copied."))
                .catch(() =>
                  setMessage(
                    "Clipboard access failed. Select and copy the text manually.",
                  ),
                );
            }}
          >
            Copy selected
          </button>
          <button
            disabled={!selected.size || live}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([text()], { type: "text/plain;charset=utf-8" }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = "hostboard-logs.txt";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setMessage("Selected displayed entries downloaded.");
            }}
          >
            Download selected
          </button>
        </div>
      </details>
      {message && (
        <p role="status" className="small">
          {message}
        </p>
      )}
      <div
        ref={viewport}
        className={`log-viewport ${wrap ? "wrap-lines" : "no-wrap"}`}
        tabIndex={0}
        role="region"
        aria-label="Log entries"
        onWheel={() => {
          if (live) stop();
        }}
        onTouchMove={() => {
          if (live) stop();
        }}
        onKeyDown={(e) => {
          if (["ArrowUp", "PageUp", "Home", "Escape"].includes(e.key) && live)
            stop();
        }}
      >
        {entries.map((entry, i) => (
          <div
            className={`log-entry ${level(entry.text)} ${selected.has(i) ? "selected" : ""}`}
            key={`${i}:${entry.time}`}
          >
            <input
              type="checkbox"
              aria-label={`Select log entry ${i + 1}`}
              disabled={live}
              checked={selected.has(i)}
              onChange={(e) =>
                setSelected((v) => {
                  const n = new Set(v);
                  e.target.checked ? n.add(i) : n.delete(i);
                  return n;
                })
              }
            />
            <time dateTime={entry.time} title={entry.time}>
              {zone === "utc"
                ? entry.time.replace("T", " ").replace("Z", " UTC")
                : new Date(entry.time).toLocaleString(undefined, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    fractionalSecondDigits: 3,
                    timeZoneName: "short",
                  })}
            </time>
            <span className={`log-stream ${entry.stream}`}>{entry.stream}</span>
            <div className="log-message">
              <pre>
                <Highlight
                  text={entry.text}
                  query={filter.search}
                  sensitive={filter.caseSensitive}
                />
                {entry.truncated && (
                  <span className="muted"> [entry truncated]</span>
                )}
              </pre>
              <Structured text={entry.text} />
            </div>
          </div>
        ))}
        {!busy && !entries.length && result && (
          <p className="log-empty">
            No retained entries match this range and filter. Logs may have
            rotated away, the container may have been replaced, or the
            application may write to internal files. Docker does not report
            which earlier entries were removed.
          </p>
        )}
        {busy && (
          <p className="log-empty" role="status">
            Reading a bounded page…
          </p>
        )}
      </div>
      {result && (
        <p className="small muted">
          {result.notice} Each query scans at most 2 MiB / 5,000 records and
          returns at most 500 entries / 512 KiB. Older logs may have rotated
          away. Pause before selecting or copying entries.
        </p>
      )}
    </section>
  );
}
