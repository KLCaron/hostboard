// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import type { ServerGroup } from "./server-types";
import { updateCounts, type HostUpdates } from "./update-types";
import {
  fleetUpdateCounts,
  updatePresentation,
  updatePreview,
} from "./updates-view";
import {
  ShieldAlert,
  Package,
  Layers,
  RotateCcw,
  CircleHelp,
  CheckCircle2,
  Clock,
  AlertTriangle,
  X,
} from "lucide-react";
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
function UpdateDetails({
  h,
  busy,
  refresh,
  detailError,
}: {
  h: HostUpdates;
  busy: string;
  refresh: (h: HostUpdates) => Promise<void>;
  detailError?: string;
}) {
  const p = h.snapshot?.packages,
    d = h.snapshot?.docker;
  const unknown = p?.packages.filter((x) => x.security === null).length || 0;
  return (
    <div className="update-body">
      <div className="settings-actions">
        <button
          disabled={!!busy || h.refreshing || h.paused || !h.configured}
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
          An operator must configure the optional snapshot collector and
          restricted reader. See the update monitor setup documentation.
        </p>
      )}
      {h.error && <p className="notice danger">{h.error}</p>}
      <p className="small muted">
        Last read attempt: {when(h.lastAttemptAt)} · Received:{" "}
        {when(h.receivedAt)} · Snapshot: {when(h.snapshot?.collectedAt ?? null)}
      </p>
      {h.detailsIncluded === false && (
        <p className="notice">
          {detailError || "Loading package and service details…"}
        </p>
      )}
      <h3>
        OS packages{" "}
        {p && <span className={`update-badge ${p.state}`}>{p.state}</span>}
      </h3>
      <p>{p?.message || "Package monitoring data is unavailable."}</p>
      <p className="small muted">
        Last successful check: {when(h.packageLastSuccessAt)} · Repository
        metadata: {when(p?.metadataAt ?? null)} · Reboot:{" "}
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
                  <td className={x.security === true ? "security-text" : ""}>
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
        {d && <span className={`update-badge ${d.state}`}>{d.state}</span>}
      </h3>
      <p>{d?.message || "Docker monitoring data is unavailable."}</p>
      <p className="small muted">
        Last complete successful Docker check: {when(h.dockerLastSuccessAt)}
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
              <code>{s.deployedImageId || s.deployedConfig || "Unknown"}</code>
            </p>
            <p>
              Deployed platform manifest:{" "}
              <code>{s.deployedManifest || "Not exposed by Docker"}</code>
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
              <code>{s.deployedDigests.join(", ") || "Unavailable"}</code>
            </p>
            <p>
              Upstream manifest:{" "}
              <code>{s.upstreamDigest || "Unavailable"}</code>
            </p>
            <p>
              Upstream config: <code>{s.upstreamConfig || "Unavailable"}</code>
            </p>
            <p className="small muted">
              Last successful registry check: {when(s.checkedAt)}
            </p>
          </div>
        </details>
      ))}
    </div>
  );
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
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const readSelected = () =>
    new URLSearchParams(location.hash.split("?")[1] || "").get("host") || "";
  const [selected, setSelected] = useState(readSelected);
  const [details, setDetails] = useState<Record<string, HostUpdates>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  const panel = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    const hash = () => setSelected(readSelected());
    window.addEventListener("hashchange", hash);
    return () => {
      media.removeEventListener("change", change);
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(),
      base = hosts.find((h) => h.hostId === selected),
      old = details[selected];
    if (
      base?.detailsIncluded === false &&
      !(
        old &&
        old.receivedAt === base.receivedAt &&
        old.lastAttemptAt === base.lastAttemptAt &&
        old.error === base.error
      )
    ) {
      void updateAPI(
        "/" + encodeURIComponent(selected),
        false,
        controller.signal,
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setDetails((d) => ({ ...d, [selected]: result.host }));
            setDetailErrors((e) => ({ ...e, [selected]: "" }));
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setDetailErrors((d) => ({ ...d, [selected]: e.message }));
        });
    }
    return () => controller.abort();
  }, [hosts, selected]);
  const visible = hosts
    .filter(
      (h) =>
        !group || (group === "ungrouped" ? !h.groupId : h.groupId === group),
    )
    .sort(
      (a, b) =>
        updatePresentation(a).rank - updatePresentation(b).rank ||
        a.name.localeCompare(b.name),
    );
  const selectedBase = visible.find((h) => h.hostId === selected);
  useEffect(() => {
    const dialog = panel.current;
    if (selectedBase && !mobile && dialog && !dialog.open) dialog.showModal();
    else if ((!selectedBase || mobile) && dialog?.open) dialog.close();
  }, [selectedBase, mobile]);
  const close = () => {
    setSelected("");
    history.replaceState(null, "", "#updates");
    trigger.current?.focus();
  };
  const open = (id: string, button: HTMLButtonElement) => {
    trigger.current = button;
    if (selected === id && mobile) close();
    else {
      setSelected(id);
      history.replaceState(null, "", "#updates?host=" + encodeURIComponent(id));
    }
  };
  const fullHost = (base: HostUpdates): HostUpdates => {
    const old = details[base.hostId];
    return old &&
      old.receivedAt === base.receivedAt &&
      old.lastAttemptAt === base.lastAttemptAt &&
      old.error === base.error
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
  };
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
  const totals = fleetUpdateCounts(visible);
  const counters = [
    { label: "Pending packages", value: totals.packages, Icon: Package },
    {
      label: "Security updates",
      value: totals.security,
      Icon: ShieldAlert,
      tone: "security-text",
    },
    { label: "Changed Compose images", value: totals.images, Icon: Layers },
    { label: "Reboot-required hosts", value: totals.reboots, Icon: RotateCcw },
    {
      label: "Unknown / unconfigured hosts",
      value: totals.unknown,
      Icon: CircleHelp,
    },
  ];
  return (
    <section className="updates-page" aria-label="Update monitor">
      <div className="updates-toolbar">
        <p className="muted">
          <span className="updates-desktop-copy">
            Read-only monitoring. Status refresh reads the latest snapshot; host
            checks normally run every six hours.
          </span>
          <span className="updates-mobile-copy">
            Read-only monitoring · snapshots checked every six hours.
          </span>
        </p>
        <label>
          Server group{" "}
          <select
            value={group}
            onChange={(e) => {
              setGroup(e.target.value);
              close();
            }}
          >
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
      <div className="updates-fleet" aria-label="Fleet update totals">
        {counters.map(({ label, value, Icon, tone }) => (
          <div key={label} className={tone || ""}>
            <Icon size={17} aria-hidden="true" />
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p className="small muted updates-explainer">
        <span className="updates-desktop-copy">
          Counts cover active hosts in this group and include last observations.
          Unknown or stale results are incomplete; zero does not establish that
          those hosts are current. Changed images count unique Compose services,
          not container instances. A changed digest indicates different tag
          content, not a confirmed newer software version.
        </span>
        <span className="updates-mobile-copy">
          Observed counts; stale/unknown hosts are incomplete. Digest changes do
          not confirm newer versions.
        </span>{" "}
      </p>
      {hosts.length === 0 && !error && <p>Loading registered hosts…</p>}
      {hosts.length > 0 && visible.length === 0 && (
        <p>No hosts in this group.</p>
      )}
      <div className="updates-grid">
        {visible.map((base) => {
          const view = updatePresentation(base),
            c = view.counts,
            p = base.snapshot?.packages;
          const preview = base.preview || updatePreview(base.snapshot);
          const Icon =
            view.tone === "security"
              ? ShieldAlert
              : view.tone === "current"
                ? CheckCircle2
                : view.stale
                  ? Clock
                  : AlertTriangle;
          const active = selected === base.hostId;
          return (
            <article
              className={`update-card update-tone-${view.tone}`}
              key={base.hostId}
              aria-label={base.name}
            >
              <header>
                <h2>{base.name}</h2>
                <span className={`update-primary ${view.tone}`}>
                  <Icon size={16} aria-hidden="true" />
                  {view.status}
                </span>
              </header>
              {(base.error ||
                view.stale ||
                (view.unknown && base.configured && base.snapshot)) && (
                <p className="small warning-text">
                  {base.error
                    ? "Snapshot read failed · last observations"
                    : view.stale
                      ? "Stale data · last observations"
                      : "Partial / unavailable monitoring"}
                </p>
              )}
              <div className="update-card-counts">
                <span>
                  <strong>{c.total ?? "—"}</strong> packages
                </span>
                <span className={(c.security || 0) > 0 ? "security-text" : ""}>
                  <strong>{c.security ?? "—"}</strong> security
                </span>
                <span>
                  <strong>{c.images ?? "—"}</strong> changed images
                  {base.snapshot && base.snapshot.docker.state !== "ok"
                    ? " · partial"
                    : ""}
                </span>
              </div>
              {preview.packages.length > 0 && (
                <div
                  className="update-package-preview"
                  aria-label="Pending package names"
                >
                  {preview.packages.map((x) => (
                    <span
                      key={x.name}
                      className={x.security === true ? "security-text" : ""}
                    >
                      {x.security === true && (
                        <ShieldAlert size={12} aria-label="Security" />
                      )}
                      {x.name}
                    </span>
                  ))}
                  {(c.total || 0) > preview.packages.length && (
                    <span className="muted">
                      +{(c.total || 0) - preview.packages.length} more
                    </span>
                  )}
                </div>
              )}
              {preview.services.length > 0 && (
                <p className="small update-image-preview">
                  <Layers size={13} aria-hidden="true" /> Digest changed:{" "}
                  {preview.services
                    .map((s) => `${s.project}/${s.service}`)
                    .join(", ")}
                  {(c.images || 0) > preview.services.length
                    ? ` +${(c.images || 0) - preview.services.length} more`
                    : ""}
                </p>
              )}
              {p?.rebootRequired === true ? (
                <p className="warning-text small">
                  <RotateCcw size={13} aria-hidden="true" /> Reboot required
                </p>
              ) : (
                <p className="small muted">
                  {p?.rebootRequired === false
                    ? "No reboot flag"
                    : "Reboot status unknown"}
                </p>
              )}
              <div className="update-collection">
                <span className="small">
                  Collector:{" "}
                  {base.paused
                    ? "paused"
                    : !base.configured
                      ? "unconfigured"
                      : base.error
                        ? "read failed"
                        : !base.snapshot
                          ? "awaiting snapshot"
                          : "snapshot received"}
                </span>
                <span className="small muted">
                  Packages: {p?.state || "unavailable"} · Docker:{" "}
                  {base.snapshot?.docker.state || "unavailable"}
                </span>
                {preview.unverifiedServices > 0 && (
                  <span className="small warning-text">
                    {preview.unverifiedServices} services not comparable · see
                    details
                  </span>
                )}
                {c.unknownSecurity > 0 && (
                  <span className="small warning-text">
                    {c.unknownSecurity} package classifications unknown
                  </span>
                )}
                <span className="small muted">
                  Last collected: {when(base.snapshot?.collectedAt ?? null)}
                </span>
              </div>
              <button
                className="update-details-button"
                aria-label={`Details for ${base.name}`}
                aria-haspopup={mobile ? undefined : "dialog"}
                aria-controls={
                  mobile ? `update-details-${base.hostId}` : undefined
                }
                aria-expanded={mobile ? active : undefined}
                onClick={(e) => open(base.hostId, e.currentTarget)}
              >
                {mobile && active ? "Hide details" : "View details"}
              </button>
              {mobile && active && (
                <div
                  className="update-inline-details"
                  id={`update-details-${base.hostId}`}
                >
                  <UpdateDetails
                    h={fullHost(base)}
                    busy={busy}
                    refresh={refresh}
                    detailError={detailErrors[base.hostId]}
                  />
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!mobile && (
        <dialog
          ref={panel}
          className="update-panel"
          aria-labelledby="update-panel-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          {selectedBase && (
            <>
              <header>
                <h2 id="update-panel-title">
                  {selectedBase.name} · Update details
                </h2>
                <button
                  autoFocus
                  aria-label="Close update details"
                  onClick={close}
                >
                  <X size={20} />
                </button>
              </header>
              <UpdateDetails
                h={fullHost(selectedBase)}
                busy={busy}
                refresh={refresh}
                detailError={detailErrors[selectedBase.hostId]}
              />
            </>
          )}
        </dialog>
      )}
    </section>
  );
}
