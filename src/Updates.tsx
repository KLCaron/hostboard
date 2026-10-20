// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { ServerGroup } from "./server-types";
import { updateCounts, type HostUpdates } from "./update-types";
const when = (t: number | null) =>
  t == null ? "Never / unknown" : new Date(t * 1000).toLocaleString();
export async function updateAPI(
  route = "",
  refresh = false,
  signal?: AbortSignal,
) {
  const r = await fetch("/api/admin/updates" + route, {
    method: refresh ? "POST" : "GET",
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15000),
    ]),
    ...(refresh
      ? {
          headers: {
            "Content-Type": "application/json",
            "X-Hostboard-Request": "1",
          },
          body: "{}",
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Update monitoring unavailable");
  return data;
}
export function useUpdates() {
  const [hosts, setHosts] = useState<HostUpdates[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const d = await updateAPI("", false, controller.signal);
        if (!controller.signal.aborted) {
          setHosts(d.hosts);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(
            e instanceof Error ? e.message : "Update monitoring unavailable",
          );
          setHosts((previous) =>
            previous.map((h) => ({
              ...h,
              error: h.error || "Update monitoring connection interrupted",
              snapshot: h.snapshot
                ? {
                    ...h.snapshot,
                    packages: {
                      ...h.snapshot.packages,
                      state:
                        h.snapshot.packages.state === "ok"
                          ? "stale"
                          : h.snapshot.packages.state,
                    },
                    docker: {
                      ...h.snapshot.docker,
                      state:
                        h.snapshot.docker.state === "ok"
                          ? "stale"
                          : h.snapshot.docker.state,
                    },
                  }
                : null,
            })),
          );
        }
      }
    };
    void load();
    const timer = setInterval(load, 60000);
    window.addEventListener("hostboard:servers", load);
    window.addEventListener("hostboard:updates", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("hostboard:servers", load);
      window.removeEventListener("hostboard:updates", load);
    };
  }, []);
  return { hosts, error };
}
export function UpdateSummary({ host }: { host: HostUpdates }) {
  const p = host.snapshot?.packages,
    d = host.snapshot?.docker;
  const counts = host.counts || updateCounts(host.snapshot);
  return (
    <span className="update-counts">
      <span className={p?.state === "ok" ? "" : "muted"}>
        {counts.total ?? "—"} total packages
      </span>
      <span>{counts.ordinary ?? "—"} ordinary</span>
      <span className="security-text">{counts.security ?? "—"} security</span>
      {counts.unknownSecurity > 0 && (
        <span className="warning-text">
          {counts.unknownSecurity} unknown security
        </span>
      )}
      <span>
        {counts.images ?? "—"} Compose services with changed images
        {d && d.state !== "ok" ? " (partial)" : ""}
      </span>
      <span>
        {p?.rebootRequired === true
          ? "Reboot required"
          : p?.rebootRequired === false
            ? "No reboot flag"
            : "Reboot unknown"}
      </span>
    </span>
  );
}
export function updateHealth(h: HostUpdates) {
  if (h.paused)
    return h.archived
      ? "Archived · polling stopped"
      : "Disabled · polling stopped";
  if (!h.configured) return "Not configured";
  if (h.error) return "Snapshot read failed · last observations below";
  if (!h.snapshot) return "Awaiting first snapshot";
  return `Packages: ${h.snapshot.packages.state} · Docker: ${h.snapshot.docker.state}`;
}
export function UpdatesPage({
  hosts,
  error,
  groups = [],
}: {
  hosts: HostUpdates[];
  error: string;
  groups?: ServerGroup[];
}) {
  const [group, setGroup] = useState(""),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState("");
  const [selected, setSelected] = useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1] || "").get("host") || "",
  );
  const [details, setDetails] = useState<Record<string, HostUpdates>>({});
  const [opened, setOpened] = useState<string[]>(selected ? [selected] : []);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const id of opened) {
      const base = hosts.find((h) => h.hostId === id),
        old = details[id];
      if (
        !base ||
        base.detailsIncluded !== false ||
        (old &&
          old.receivedAt === base.receivedAt &&
          old.lastAttemptAt === base.lastAttemptAt &&
          old.error === base.error &&
          old.paused === base.paused)
      )
        continue;
      void updateAPI("/" + encodeURIComponent(id), false, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setDetails((d) => ({ ...d, [id]: result.host }));
            setDetailErrors((e) => ({ ...e, [id]: "" }));
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setDetailErrors((errors) => ({
              ...errors,
              [id]: e instanceof Error ? e.message : "Details unavailable",
            }));
        });
    }
    return () => controller.abort();
  }, [hosts, opened]);
  useEffect(() => {
    const change = () =>
      setSelected(
        new URLSearchParams(location.hash.split("?")[1] || "").get("host") ||
          "",
      );
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  async function refresh(h: HostUpdates) {
    setBusy(h.hostId);
    setMessage("");
    try {
      const result = await updateAPI(
        `/${encodeURIComponent(h.hostId)}/refresh`,
        true,
      );
      setMessage(
        result.refreshed
          ? "Monitoring snapshot refreshed."
          : result.host?.error ||
              "Refresh already active or limited to once per minute.",
      );
      if (result.host) setDetails((d) => ({ ...d, [h.hostId]: result.host }));
      window.dispatchEvent(new Event("hostboard:updates"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="updates-page" aria-label="Update monitor">
      <p className="muted">
        Read-only monitoring. Status refresh reads the latest host snapshot.
        Scheduled host checks normally run every six hours. Changed image
        digests indicate different tag content, not confirmed newer software
        versions. Summaries count unique Compose services; details show
        container instances.
      </p>
      {error && (
        <div role="alert" className="notice danger">
          {error}. Previously displayed observations may be stale.
        </div>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div className="settings-actions">
        <label>
          Server group{" "}
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">Entire fleet</option>
            <option value="ungrouped">Ungrouped</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {hosts.length === 0 && !error && <p>Loading registered hosts…</p>}
      {hosts
        .filter(
          (h) =>
            !group ||
            (group === "ungrouped" ? !h.groupId : h.groupId === group),
        )
        .map((base) => {
          const old = details[base.hostId];
          const cached =
            old &&
            old.receivedAt === base.receivedAt &&
            old.lastAttemptAt === base.lastAttemptAt &&
            old.error === base.error &&
            old.paused === base.paused;
          // Keep current registry names, health and freshness from the compact
          // overview while reusing only the unchanged large inventory arrays.
          const h: HostUpdates = cached
            ? {
                ...base,
                detailsIncluded: true,
                snapshot:
                  base.snapshot && old.snapshot
                    ? {
                        ...base.snapshot,
                        packages: {
                          ...base.snapshot.packages,
                          packages: old.snapshot.packages.packages,
                        },
                        docker: {
                          ...base.snapshot.docker,
                          services: old.snapshot.docker.services,
                        },
                      }
                    : base.snapshot,
              }
            : base;
          const p = h.snapshot?.packages,
            d = h.snapshot?.docker;
          const unknown =
            p?.packages.filter((x) => x.security === null).length || 0;
          return (
            <details
              className="update-host"
              key={h.hostId}
              onToggle={(e) => {
                const open = e.currentTarget.open;
                setOpened((ids) =>
                  open
                    ? ids.includes(h.hostId)
                      ? ids
                      : [...ids, h.hostId]
                    : ids.filter((id) => id !== h.hostId),
                );
              }}
              open={selected === h.hostId || undefined}
            >
              <summary>
                <strong>{h.name}</strong>
                <UpdateSummary host={h} />
                <span
                  className={
                    h.error || p?.state !== "ok" || d?.state !== "ok"
                      ? "warning-text"
                      : "muted"
                  }
                >
                  {updateHealth(h)}
                </span>
                <span className="small muted">
                  Last collected: {when(h.snapshot?.collectedAt ?? null)}
                </span>
              </summary>
              <div className="update-body">
                <div className="settings-actions">
                  <button
                    disabled={
                      !!busy || h.refreshing || h.paused || !h.configured
                    }
                    aria-busy={busy === h.hostId}
                    onClick={() => void refresh(h)}
                  >
                    Refresh Status
                  </button>
                  <a
                    className="action-link"
                    href={`#host=${encodeURIComponent(h.hostId)}`}
                  >
                    Host metrics
                  </a>
                </div>
                {!h.configured && (
                  <p className="notice">
                    An operator must configure the optional snapshot collector
                    and restricted reader. See the update monitor setup
                    documentation.
                  </p>
                )}
                {h.error && <p className="notice danger">{h.error}</p>}
                <p className="small muted">
                  Last read attempt: {when(h.lastAttemptAt)} · Received:{" "}
                  {when(h.receivedAt)} · Snapshot:{" "}
                  {when(h.snapshot?.collectedAt ?? null)}
                </p>
                {h.detailsIncluded === false && (
                  <p className="notice">
                    {detailErrors[h.hostId] ||
                      "Loading package and service details…"}
                  </p>
                )}
                <h3>
                  OS packages{" "}
                  {p && (
                    <span className={`update-badge ${p.state}`}>{p.state}</span>
                  )}
                </h3>
                <p>{p?.message || "Package monitoring data is unavailable."}</p>
                <p className="small muted">
                  Last successful check: {when(h.packageLastSuccessAt)} ·
                  Repository metadata: {when(p?.metadataAt ?? null)} · Reboot:{" "}
                  {p?.rebootRequired === true
                    ? "Required"
                    : p?.rebootRequired === false
                      ? "No reboot-required flag"
                      : "Unknown"}
                </p>
                {unknown > 0 && (
                  <p className="notice">
                    Security classification is unknown for {unknown} package(s);
                    third-party advisories are not available.
                  </p>
                )}
                {p &&
                  ["ok", "stale"].includes(p.state) &&
                  p.packages.length === 0 &&
                  h.detailsIncluded !== false && (
                    <p>
                      {p.state === "ok"
                        ? "No pending package updates in the current cache."
                        : "No pending updates in the last observed cache; metadata is stale."}
                    </p>
                  )}
                {!!p?.packages.length && (
                  <div className="update-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Package</th>
                          <th>Installed</th>
                          <th>Available</th>
                          <th>Classification</th>
                          <th>Repository / source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.packages.map((x, i) => (
                          <tr key={i}>
                            <td>{x.name}</td>
                            <td>{x.installed}</td>
                            <td>{x.available}</td>
                            <td
                              className={
                                x.security === true ? "security-text" : ""
                              }
                            >
                              {x.security === true
                                ? "Security"
                                : x.security === false
                                  ? "Ordinary"
                                  : "Unknown security"}
                            </td>
                            <td>{x.sources.join(", ") || "Unknown"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <h3>
                  Docker Compose{" "}
                  {d && (
                    <span className={`update-badge ${d.state}`}>{d.state}</span>
                  )}
                </h3>
                <p>{d?.message || "Docker monitoring data is unavailable."}</p>
                <p className="small muted">
                  Last complete successful Docker check:{" "}
                  {when(h.dockerLastSuccessAt)}
                </p>
                {d?.state === "ok" &&
                  !d.services.length &&
                  h.detailsIncluded !== false && (
                    <p>No Compose-managed containers found.</p>
                  )}
                {d?.services.map((s) => (
                  <details key={s.container} className="update-service">
                    <summary>
                      <strong>
                        {s.project} / {s.service}
                      </strong>{" "}
                      <span className={`update-badge ${s.state}`}>
                        {s.state === "update"
                          ? "Upstream digest changed"
                          : s.state === "current"
                            ? "Digest unchanged"
                            : s.state}
                      </span>
                    </summary>
                    <div>
                      <p>
                        {s.image} · {s.platform}
                      </p>
                      <p>{s.message}</p>
                      <p>
                        Container: <code>{s.container}</code>
                      </p>
                      <p>
                        Deployed image ID:{" "}
                        <code>
                          {s.deployedImageId || s.deployedConfig || "Unknown"}
                        </code>
                      </p>
                      <p>
                        Deployed platform manifest:{" "}
                        <code>
                          {s.deployedManifest || "Not exposed by Docker"}
                        </code>
                      </p>
                      <p>
                        Deployed config:{" "}
                        <code>
                          {s.deployedConfig ||
                            "Not exposed; platform manifest comparison used"}
                        </code>
                      </p>
                      <p>
                        Deployed repository digests:{" "}
                        <code>
                          {s.deployedDigests.join(", ") || "Unavailable"}
                        </code>
                      </p>
                      <p>
                        Upstream manifest:{" "}
                        <code>{s.upstreamDigest || "Unavailable"}</code>
                      </p>
                      <p>
                        Upstream config:{" "}
                        <code>{s.upstreamConfig || "Unavailable"}</code>
                      </p>
                      <p className="small muted">
                        Last successful registry check: {when(s.checkedAt)}
                      </p>
                    </div>
                  </details>
                ))}
              </div>
            </details>
          );
        })}
    </section>
  );
}
