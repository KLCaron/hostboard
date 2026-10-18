// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { Host } from "./types";
import type { MonitorView } from "./monitor-types";
import type { LogContext, LogSource } from "./log-types";
import { logApi } from "./Logs";
import { logLink, parseLogRoute } from "./log-navigation";
export function LogSettings({
  hosts,
  data,
  admin,
}: {
  hosts: Host[];
  data?: MonitorView;
  admin: boolean;
}) {
  const linked = parseLogRoute(location.hash);
  const contexts = [
    ...(data?.checks ?? []).map((c) => ({
      label: `Service · ${c.name} · ${c.hostId} · generation ${c.generation}`,
      context: {
        hostId: c.hostId,
        serviceId: c.id,
        generation: c.generation,
      } as LogContext,
    })),
    ...hosts.flatMap((h) =>
      h.containers.map((c) => ({
        label: `Container · ${c.name} · ${h.name}`,
        context: { hostId: h.id, container: c.name } as LogContext,
      })),
    ),
  ];
  if (linked.context.incidentId && !linked.invalid)
    contexts.unshift({
      label: `Historical incident #${linked.context.incidentId} · ${linked.host}`,
      context: linked.context,
    });
  const linkedIndex = contexts.findIndex(
    (x) =>
      x.context.hostId === linked.host &&
      (linked.context.incidentId
        ? x.context.incidentId === linked.context.incidentId
        : linked.context.serviceId
          ? x.context.serviceId === linked.context.serviceId &&
            (!linked.context.generation ||
              x.context.generation === linked.context.generation)
          : linked.context.container
            ? x.context.container === linked.context.container
            : false),
  );
  const [choice, setChoice] = useState(
    linkedIndex < 0 ? "" : JSON.stringify(contexts[linkedIndex].context),
  );
  const [sources, setSources] = useState<LogSource[]>([]),
    [mapped, setMapped] = useState<string[]>([]),
    [draft, setDraft] = useState<string[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!choice && linkedIndex >= 0)
      setChoice(JSON.stringify(contexts[linkedIndex].context));
  }, [linkedIndex]);
  const context: LogContext | undefined = choice
    ? JSON.parse(choice)
    : undefined;
  useEffect(() => {
    if (!admin || !context) return;
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    setError("");
    setMessage("");
    void Promise.all([
      logApi(`sources/${context.hostId}`, undefined, controller.signal),
      logApi("context", context, controller.signal),
    ])
      .then(([catalog, association]) => {
        if (active) {
          setSources(catalog.sources);
          setMapped(association.sources);
          setDraft(association.sources);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [choice, admin]);
  return (
    <section className="monitor-panel" aria-label="Log source associations">
      <h2>Log source associations</h2>
      <p className="detail-description">
        Explicitly associate monitored services and container resources with
        approved sources. Service mappings retain their generation identity.
        Names alone never create an association.
      </p>
      {!admin ? (
        <p className="notice">
          An authorized administrator must sign in to read or change source
          associations.
        </p>
      ) : (
        <>
          <label className="log-source-label">
            Service or container
            <select
              aria-label="Association context"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">Choose a service or container…</option>
              {contexts.map((x) => (
                <option
                  key={JSON.stringify(x.context)}
                  value={JSON.stringify(x.context)}
                >
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="notice danger">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="notice">
              {message}
            </p>
          )}
          {busy ? (
            <p role="status">Loading approved sources and associations…</p>
          ) : (
            context &&
            !error && (
              <form
                className="log-associations"
                onSubmit={(e) => {
                  e.preventDefault();
                  setBusy(true);
                  setMessage("");
                  void logApi(
                    "context",
                    { context, sources: draft },
                    undefined,
                    "PUT",
                  )
                    .then(() => {
                      setMapped(draft);
                      setMessage("Source associations saved.");
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                <p>
                  {mapped.length
                    ? `${mapped.length} associated source(s)`
                    : "Unconfigured · no source association"}{" "}
                  · {context.hostId}
                </p>
                {sources.map((s) => (
                  <label key={s.id}>
                    <input
                      type="checkbox"
                      checked={draft.includes(s.id)}
                      onChange={(e) =>
                        setDraft((v) =>
                          e.target.checked
                            ? [...v, s.id]
                            : v.filter((id) => id !== s.id),
                        )
                      }
                    />
                    <span>
                      <b>{s.name}</b> · {s.hostId} / {s.id}
                      <br />
                      {s.available
                        ? `Available · ${s.containerName} · ${s.containerId?.slice(0, 12)} · ${s.driver}`
                        : `Unavailable · ${s.error || "Container not found"}`}
                    </span>
                  </label>
                ))}
                {draft
                  .filter((id) => !sources.some((s) => s.id === id))
                  .map((id) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setDraft((v) => v.filter((s) => s !== id))
                        }
                      />
                      <span>
                        {id} · no longer approved · remove this stale
                        association before saving
                      </span>
                    </label>
                  ))}
                {!sources.length && (
                  <p className="notice">
                    No approved sources on this host. Configure the optional
                    adapter and its host allowlist first.
                  </p>
                )}
                <button
                  disabled={
                    busy ||
                    draft.some((id) => !sources.some((s) => s.id === id))
                  }
                >
                  Save associations
                </button>{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft([])}
                >
                  Clear associations
                </button>{" "}
                <a className="text-link" href={logLink(context)}>
                  View logs →
                </a>
                <p className="small muted">
                  Removing an association does not remove the approved host
                  source. Container replacement cannot retrieve the removed
                  container’s historical logs. Stable source IDs and the
                  deployment-owned allowlist determine which container may be
                  read.
                </p>
              </form>
            )
          )}
        </>
      )}
    </section>
  );
}
