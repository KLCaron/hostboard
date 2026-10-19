import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { readPreference, savePreference } from "./preferences";
import { chartTooltipTheme } from './chartTheme';
import {
  normalizeLayout,
  moveWidget,
  type WidgetPreference,
  type Layout,
} from "./layout";
import type { Host, Range } from "./types";
import type { Metric, MetricHistory } from "./investigation-types";
import { useDisplay, temperature } from "./display";
export interface Widget {
  id: string;
  title: string;
  node: ReactNode;
  width: "half" | "full";
  expanded?: boolean;
}
function MetricWidget({
  preference,
  hosts,
  editing,
  onChange,
  range,
}: {
  preference: WidgetPreference;
  hosts: Host[];
  editing: boolean;
  onChange: (patch: Partial<WidgetPreference>) => void;
  range: Range;
}) {
  const display = useDisplay(),
    host = hosts.find((h) => h.id === (preference.host || hosts[0]?.id)),
    [catalog, setCatalog] = useState<Metric[]>([]),
    [data, setData] = useState<MetricHistory>(),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!host) return;
    const controller = new AbortController();
    setCatalog([]);
    void fetch(`/api/hosts/${host.id}/metrics`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error();
        setCatalog(await r.json());
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Available metrics could not be discovered.");
      });
    return () => controller.abort();
  }, [host?.id]);
  const metric = catalog.find((m) => m.id === preference.metric);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setData(undefined);
    setError("");
    if (!host || !metric) return;
    const controller = new AbortController(),
      before = Math.floor(Date.now() / 1000),
      after =
        before - { "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400 }[range];
    void fetch(
      `/api/hosts/${host.id}/metric-history?chart=${encodeURIComponent(metric.id)}&after=${after}&before=${before}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw Error();
        setData(await r.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Metric history unavailable.");
      });
    return () => controller.abort();
  }, [host?.id, metric?.id, range, tick]);
  const dimension = data?.dimensions[0];
  const isTemp = /celsius|°c/i.test(metric?.units ?? "");
  const points = data?.points.map((p) => ({
    ...p,
    value:
      p[`${dimension}:average`] == null
        ? null
        : isTemp && display.temperature === "F"
          ? (p[`${dimension}:average`]! * 9) / 5 + 32
          : p[`${dimension}:average`],
  }));
  return (
    <section className="monitor-panel metric-widget">
      <h2>{metric?.description || metric?.name || "Preferred metric"}</h2>
      <p className="muted">
        {host?.name ?? "Host unavailable"} ·{" "}
        {isTemp
          ? `°${display.temperature}`
          : (metric?.units ?? "Choose an available reading")}
      </p>
      {editing && (
        <div className="metric-selectors">
          <label>
            Metric host
            <select
              aria-label="Metric host"
              value={host?.id ?? ""}
              onChange={(e) =>
                onChange({ host: e.target.value, metric: undefined })
              }
            >
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preferred metric
            <select
              aria-label="Preferred metric"
              value={preference.metric ?? ""}
              onChange={(e) => onChange({ metric: e.target.value })}
            >
              <option value="">Choose a metric</option>
              {[...catalog]
                .sort(
                  (a, b) =>
                    a.group.localeCompare(b.group) ||
                    a.name.localeCompare(b.name),
                )
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.group} · {m.description || m.name} · {m.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      {host?.status !== "online" && (
        <p className="notice">
          Host {host?.status ?? "unavailable"}; readings are not live.
        </p>
      )}
      {error && <p className="notice">{error}</p>}
      {preference.metric && !metric && (
        <p className="muted">
          Selected metric is unavailable or no longer collected on this host.
        </p>
      )}
      {!preference.metric && (
        <p className="muted">
          Choose a discovered CPU, memory, swap, storage, network, temperature
          or container metric in customization mode.
        </p>
      )}
      {data && (
        <>
          <p className="small muted">
            {dimension} · average per bucket · gaps indicate missing samples
          </p>
          <div className={`preferred-chart ${preference.height}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points}>
                <XAxis
                  dataKey="time"
                  tickFormatter={(t) =>
                    new Date(t * 1000).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  }
                  minTickGap={55}
                  stroke="#88968e"
                  fontSize={11}
                />
                <YAxis width={45} stroke="#88968e" fontSize={11} />
                <Tooltip
                  {...chartTooltipTheme}
                  formatter={(v) =>
                    typeof v === "number"
                      ? isTemp
                        ? temperature(
                            display.temperature === "F"
                              ? ((v - 32) * 5) / 9
                              : v,
                            display.temperature,
                          )
                        : v.toFixed(2)
                      : "—"
                  }
                  labelFormatter={(v) =>
                    new Date(Number(v) * 1000).toLocaleString()
                  }
                />
                <Line
                  dataKey="value"
                  stroke="#bbdf93"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <a className="text-link" href={`#host=${host?.id}`}>
            Investigate host metrics →
          </a>
        </>
      )}
    </section>
  );
}
export function Dashboard({
  widgets,
  hosts,
  range,
  visibleHostIds,
}: {
  visibleHostIds?: string[];
  widgets: Widget[];
  hosts: Host[];
  range: Range;
}) {
  const defaults = useMemo(
    () => [
      ...widgets.map(({ id, width }) => ({
        id,
        width,
        visible: true,
        height: "auto" as const,
      })),
      ...["metric-a", "metric-b"].map((id) => ({
        id,
        width: "half" as const,
        visible: false,
        height: "auto" as const,
      })),
    ],
    [widgets.map((w) => w.id).join(",")],
  );
  const [layout, setLayout] = useState<Layout>(() =>
      normalizeLayout(readPreference("layout-v1", null), defaults),
    ),
    [draft, setDraft] = useState(layout),
    [editing, setEditing] = useState(false),
    [message, setMessage] = useState(""),
    [dragging, setDragging] = useState<string>();
  useEffect(() => {
    setLayout((l) => normalizeLayout(l, defaults));
    setDraft((l) => normalizeLayout(l, defaults));
  }, [defaults]);
  const current = editing ? draft : layout;
  function patch(id: string, p: Partial<WidgetPreference>) {
    setDraft((l) => ({
      ...l,
      widgets: l.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)),
    }));
  }
  function reset() {
    const next = normalizeLayout(null, defaults);
    setDraft(next);
    setLayout(next);
    const saved = savePreference("layout-v1", next);
    setMessage(
      saved
        ? "Default layout restored"
        : "Browser storage unavailable; reset applies for this session only",
    );
  }
  return (
    <>
      <div className="dashboard-toolbar">
        <p className="small muted">
          {editing
            ? "Drag a handle or use the move buttons. Changes apply to this browser."
            : "Your fleet at a glance"}
        </p>
        <div>
          {!editing ? (
            <button
              onClick={() => {
                setDraft(layout);
                setEditing(true);
                setMessage("");
              }}
            >
              Customize Overview
            </button>
          ) : (
            <>
              <button
                className="primary-button"
                onClick={() => {
                  setLayout(draft);
                  const saved = savePreference("layout-v1", draft);
                  setEditing(false);
                  setMessage(
                    saved
                      ? "Dashboard layout saved on this browser"
                      : "Browser storage unavailable; layout applies for this session only",
                  );
                }}
              >
                Save layout
              </button>
              <button
                onClick={() => {
                  setDraft(layout);
                  setEditing(false);
                  setMessage("Changes cancelled");
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (
                    confirm(
                      "Restore the original curated layout and metric choices?",
                    )
                  )
                    reset();
                }}
              >
                Restore default layout
              </button>
            </>
          )}
        </div>
      </div>
      {message && (
        <p role="status" className="small muted">
          {message}
        </p>
      )}
      {editing && (
        <fieldset className="widget-visibility">
          <legend>Visible widgets</legend>
          {current.widgets.map((w) => (
            <label key={w.id}>
              <input
                type="checkbox"
                checked={w.visible}
                onChange={(e) => patch(w.id, { visible: e.target.checked })}
              />
              {widgets.find((x) => x.id === w.id)?.title ??
                (w.id === "metric-a"
                  ? "Preferred metric 1"
                  : "Preferred metric 2")}
            </label>
          ))}
        </fieldset>
      )}
      <div className={`dashboard-grid ${editing ? "editing" : ""}`}>
        {current.widgets
          .filter((w) => w.visible && (!w.id.startsWith("host-") || !visibleHostIds || visibleHostIds.includes(w.id.slice(5))))
          .map((w) => {
            const widget = widgets.find((x) => x.id === w.id),
              index = current.widgets.findIndex((x) => x.id === w.id),
              title =
                widget?.title ??
                (w.id === "metric-a"
                  ? "Preferred metric 1"
                  : "Preferred metric 2");
            return (
              <div
                key={w.id}
                data-widget={w.id}
                data-width={w.width}
                className={`dashboard-widget ${widget?.expanded ? "full" : w.width} ${w.height}`}
                onDragOver={(e) => {
                  if (editing) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (editing && dragging) {
                    setDraft((l) => moveWidget(l, dragging, w.id));
                    setDragging(undefined);
                  }
                }}
              >
                {editing && (
                  <div className="widget-controls">
                    <button
                      className="drag-handle"
                      draggable
                      aria-label={`Drag ${title}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", w.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(w.id);
                      }}
                      onDragEnd={() => setDragging(undefined)}
                    >
                      ⠿ {title}
                    </button>
                    <button
                      aria-label={`Move ${title} earlier`}
                      disabled={index === 0}
                      onClick={() =>
                        setDraft((l) =>
                          moveWidget(l, w.id, l.widgets[index - 1].id),
                        )
                      }
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${title} later`}
                      disabled={index === current.widgets.length - 1}
                      onClick={() =>
                        setDraft((l) =>
                          moveWidget(l, w.id, l.widgets[index + 1].id),
                        )
                      }
                    >
                      ↓
                    </button>
                    <select
                      aria-label={`Width of ${title}`}
                      value={w.width}
                      onChange={(e) =>
                        patch(w.id, {
                          width: e.target.value as "half" | "full",
                        })
                      }
                    >
                      <option value="half">Standard</option>
                      <option value="full">Wide</option>
                    </select>
                    <select
                      aria-label={`Height of ${title}`}
                      value={w.height}
                      onChange={(e) =>
                        patch(w.id, {
                          height: e.target.value as "auto" | "tall",
                        })
                      }
                    >
                      <option value="auto">Natural height</option>
                      <option value="tall">Tall</option>
                    </select>
                    <button
                      aria-label={`Hide ${title}`}
                      onClick={() => patch(w.id, { visible: false })}
                    >
                      Hide
                    </button>
                  </div>
                )}
                {widget?.node ?? (
                  <MetricWidget
                    preference={w}
                    hosts={hosts}
                    range={range}
                    editing={editing}
                    onChange={(p) => patch(w.id, p)}
                  />
                )}
              </div>
            );
          })}
      </div>
    </>
  );
}
