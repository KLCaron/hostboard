// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { adminRequest } from "./Settings";
import { validRegistry, type UpdateSettingsView } from "./update-settings";
const when = (v: number | null) =>
  v === null ? "Never / unknown" : new Date(v * 1000).toLocaleString();
const emptyHost = { enabled: true, proposedRegistries: [] as string[] };
export function UpdateSettings({
  admin,
  onDirty,
}: {
  admin: boolean;
  onDirty: (v: boolean) => void;
}) {
  const [data, setData] = useState<UpdateSettingsView>();
  const [timing, setTiming] = useState({
    intervalSeconds: 21600,
    staleSeconds: 86400,
  });
  const [id, setId] = useState(
    new URLSearchParams(location.hash.split("?")[1] || "").get("host") || "",
  );
  const [hostDraft, setHostDraft] = useState(emptyHost),
    [entry, setEntry] = useState("");
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const host = data?.hosts.find((h) => h.hostId === id);
  const savedHost = data?.preferences.hosts[id] ?? emptyHost;
  const timingDirty =
    !!data &&
    (timing.intervalSeconds !== data.preferences.intervalSeconds ||
      timing.staleSeconds !== data.preferences.staleSeconds);
  const hostDirty =
    !!data &&
    (JSON.stringify(hostDraft) !== JSON.stringify(savedHost) || !!entry);
  useEffect(() => {
    onDirty(timingDirty || hostDirty);
    return () => onDirty(false);
  }, [timingDirty, hostDirty, onDirty]);
  useEffect(() => {
    if (!admin) return;
    const controller = new AbortController();
    void fetch("/api/admin/updates/settings", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("Updates configuration unavailable");
        return r.json() as Promise<UpdateSettingsView>;
      })
      .then((value) => {
        setData(value);
        setTiming({
          intervalSeconds: value.preferences.intervalSeconds,
          staleSeconds: value.preferences.staleSeconds,
        });
        const selected = value.hosts.some((h) => h.hostId === id)
          ? id
          : (value.hosts[0]?.hostId ?? "");
        setId(selected);
        setHostDraft(value.preferences.hosts[selected] ?? emptyHost);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [admin]);
  async function save(hostOnly: boolean) {
    if (!data) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const value: UpdateSettingsView = await adminRequest(
        hostOnly
          ? `updates/settings/hosts/${encodeURIComponent(id)}`
          : "updates/settings",
        hostOnly
          ? { revision: data.revision, host: hostDraft }
          : { revision: data.revision, ...timing },
        "PUT",
      );
      setData(value);
      if (hostOnly) setHostDraft(value.preferences.hosts[id] ?? emptyHost);
      else
        setTiming({
          intervalSeconds: value.preferences.intervalSeconds,
          staleSeconds: value.preferences.staleSeconds,
        });
      setMessage(
        hostOnly
          ? "Host preferences saved. Registry proposals still require operator application."
          : "Snapshot-read timing is active. The host collector timer is unchanged.",
      );
      window.dispatchEvent(new Event("hostboard:updates"));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save Updates settings",
      );
    } finally {
      setBusy(false);
    }
  }
  function add() {
    const normalized = entry.trim().toLowerCase();
    if (!validRegistry(normalized)) {
      setError(
        "Use an exact DNS hostname and optional port (1–65535), such as registry.example.com:5000. URLs, IPs, paths and wildcards are not allowed.",
      );
      return;
    }
    if (["docker.io", "index.docker.io"].includes(normalized)) {
      setError("Use registry-1.docker.io for Docker Hub.");
      return;
    }
    if (
      hostDraft.proposedRegistries.includes(normalized) ||
      host?.policy?.approvedRegistries.includes(normalized)
    ) {
      setError("This registry is already proposed or collector-confirmed.");
      return;
    }
    if (hostDraft.proposedRegistries.length >= 50) {
      setError("At most 50 proposals per host.");
      return;
    }
    setHostDraft({
      ...hostDraft,
      proposedRegistries: [...hostDraft.proposedRegistries, normalized],
    });
    setEntry("");
    setError("");
    setMessage("");
  }
  if (!admin)
    return (
      <section className="monitor-panel">
        <h2>Updates</h2>
        <p>
          An administrator session is required to view or change update
          monitoring configuration.
        </p>
      </section>
    );
  return (
    <div className="update-settings">
      {error && (
        <p role="alert" className="notice danger">
          {error}{" "}
          <button
            onClick={() => {
              if (
                !(timingDirty || hostDirty) ||
                confirm("Discard unsaved Updates settings and reload?")
              )
                location.reload();
            }}
          >
            Reload settings
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <section className="monitor-panel">
        <h2>Updates</h2>
        <p>
          Hostboard reads existing snapshots through a restricted, read-only SSH
          reader. It cannot run the collector, pull images, restart containers
          or install updates.
        </p>
        <p className="muted">
          The independent host-side systemd timer normally collects every six
          hours with jitter. Snapshot reads below do not change that timer.
          “Refresh Status” only rereads the saved snapshot.
        </p>
        {data ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(false);
            }}
          >
            <div className="settings-fields">
              <label>
                Snapshot-read interval (seconds)
                <input
                  type="number"
                  min="3600"
                  max="604800"
                  required
                  value={timing.intervalSeconds}
                  onChange={(e) =>
                    setTiming({
                      ...timing,
                      intervalSeconds: Number(e.target.value),
                    })
                  }
                />
                <small>
                  3600–604800 seconds; delay between Hostboard SSH snapshot
                  reads.
                </small>
              </label>
              <label>
                Snapshot freshness threshold (seconds)
                <input
                  type="number"
                  min={Math.max(21600, timing.intervalSeconds)}
                  max="1209600"
                  required
                  value={timing.staleSeconds}
                  onChange={(e) =>
                    setTiming({
                      ...timing,
                      staleSeconds: Number(e.target.value),
                    })
                  }
                />
                <small>
                  21600–1209600 seconds, at least the read interval. Older
                  snapshots and package metadata remain visible as stale. The
                  collector’s own package metadata policy is separate.
                </small>
              </label>
            </div>
            <div className="settings-actions">
              <button
                className="primary-button"
                disabled={busy || !timingDirty}
              >
                Save snapshot timing
              </button>
              <button
                type="button"
                disabled={busy || !timingDirty}
                onClick={() =>
                  setTiming({
                    intervalSeconds: data.preferences.intervalSeconds,
                    staleSeconds: data.preferences.staleSeconds,
                  })
                }
              >
                Cancel timing changes
              </button>
            </div>
          </form>
        ) : (
          !error && <p>Loading Updates settings…</p>
        )}
      </section>
      {data && (
        <section
          className="monitor-panel"
          aria-label="Per-host update configuration"
        >
          <h2>Host monitoring and registries</h2>
          <button
            disabled={busy || hostDirty || timingDirty}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const r = await fetch("/api/admin/updates/settings");
                if (!r.ok) throw Error("Unable to reload collector status");
                const value: UpdateSettingsView = await r.json();
                setData(value);
                setHostDraft(value.preferences.hosts[id] ?? emptyHost);
                setTiming({
                  intervalSeconds: value.preferences.intervalSeconds,
                  staleSeconds: value.preferences.staleSeconds,
                });
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Unable to reload collector status",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Reload reported status
          </button>
          <label>
            Monitored host
            <select
              value={id}
              disabled={busy}
              onChange={(e) => {
                if (hostDirty && !confirm("Discard unsaved host preferences?"))
                  return;
                setId(e.target.value);
                setHostDraft(
                  data.preferences.hosts[e.target.value] ?? emptyHost,
                );
                setEntry("");
                setMessage("");
                setError("");
              }}
            >
              {data.hosts.map((h) => (
                <option key={h.hostId} value={h.hostId}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          {!data.hosts.length && (
            <p>No registered hosts. Register a server first.</p>
          )}
          {host && (
            <>
              <p>
                Reader:{" "}
                {host.reader
                  ? `${host.reader.address}:${host.reader.port} · ${host.reader.nodeGuid}`
                  : "Not configured; operator setup required"}
              </p>
              <p>
                Monitoring:{" "}
                {host.paused
                  ? "Snapshot reads paused"
                  : host.configured
                    ? "Snapshot reads enabled"
                    : "Not configured"}{" "}
                · Packages: {host.packageState} · Docker: {host.dockerState}
              </p>
              <p className="small muted">
                Collected: {when(host.collectedAt)} · Received:{" "}
                {when(host.receivedAt)}
                {host.error ? ` · ${host.error}` : ""}
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={hostDraft.enabled}
                  onChange={(e) =>
                    setHostDraft({ ...hostDraft, enabled: e.target.checked })
                  }
                />
                Enable Hostboard snapshot reads for this host
              </label>
              <p className="small muted">
                Archived or disabled servers also stop snapshot reads. The local
                collector continues independently. SSH destination, key and node
                identity remain deployment-managed.
              </p>
              <h3>Collector-confirmed registry approvals</h3>
              {host.policy ? (
                <>
                  <p>
                    {host.policy.approvedRegistries.join(", ") ||
                      "No registries approved"}
                  </p>
                  <p className="small muted">
                    As reported by the collector at {when(host.collectedAt)}
                    {host.policyStale
                      ? " · last observation; current policy is unverified"
                      : ""}
                    . Collector package metadata threshold:{" "}
                    {host.policy.packageStaleSeconds} seconds.
                  </p>
                </>
              ) : (
                <p>
                  Unknown. This snapshot has no registry policy report. An
                  operator must install the current collector and wait for a new
                  snapshot; successful image checks alone do not prove the
                  complete allowlist.
                </p>
              )}
              <h3>Checks missing registry approval</h3>
              {host.missing.length ? (
                <ul>
                  {host.missing.map((s, i) => (
                    <li key={i}>
                      {s.project}/{s.service}: <code>{s.registry}</code> ·{" "}
                      {s.image}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No missing approvals reported in the last snapshot. Other
                  unavailable checks may have different causes.
                </p>
              )}
              <h3>Proposed additional registries</h3>
              <p>
                These proposals are saved in Hostboard only. They are not active
                host permissions. Removing a proposal does not revoke an
                existing host approval.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <div className="settings-actions">
                  <label>
                    Additional registry hostname
                    <input
                      value={entry}
                      onChange={(e) => setEntry(e.target.value)}
                      placeholder="registry.example.com:5000"
                      maxLength={259}
                    />
                  </label>
                  <button disabled={busy || !entry.trim()}>Add proposal</button>
                </div>
              </form>
              <ul>
                {hostDraft.proposedRegistries.map((r) => (
                  <li key={r}>
                    <code>{r}</code> ·{" "}
                    {host.policy?.approvedRegistries.includes(r)
                      ? "Collector-confirmed in last snapshot"
                      : "Requires operator application"}{" "}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        setHostDraft({
                          ...hostDraft,
                          proposedRegistries:
                            hostDraft.proposedRegistries.filter((v) => v !== r),
                        })
                      }
                    >
                      Remove proposal {r}
                    </button>
                  </li>
                ))}
              </ul>
              <div className="settings-actions">
                <button
                  className="primary-button"
                  disabled={busy || !hostDirty || !!entry}
                  onClick={() => void save(true)}
                >
                  Save host preferences
                </button>
                <button
                  disabled={busy || !hostDirty}
                  onClick={() => {
                    setHostDraft(savedHost);
                    setEntry("");
                  }}
                >
                  Cancel host changes
                </button>
              </div>
              {!!hostDraft.proposedRegistries.length && (
                <details className="update-operator-guide">
                  <summary>
                    Review operator instructions for {host.name}
                  </summary>
                  <p>
                    {hostDirty
                      ? "Unsaved preview. Save host preferences to persist these proposals."
                      : "Saved proposals; operator application is still required."}
                  </p>
                  <ol>
                    <li>
                      On <strong>{host.name}</strong> (registered ID{" "}
                      <code>{host.hostId}</code>), use your trusted local
                      administrator access. Check that{" "}
                      <code>/etc/hostboard-updates.json</code> has this hostId
                      and nodeGuid{" "}
                      <code>
                        {host.reader?.nodeGuid ??
                          "(reader identity not configured; verify registration before proceeding)"}
                      </code>
                      . Stop if the identity differs.
                    </li>
                    <li>
                      Make a protected root-owned backup of that file. Using{" "}
                      <code>sudoedit /etc/hostboard-updates.json</code>, merge
                      only the entries below into its existing{" "}
                      <code>registries</code> object. Preserve all other
                      registries, settings and private credentials. Add only
                      missing registry keys; never overwrite an existing
                      registry policy. Do not replace the whole file with this
                      fragment.
                    </li>
                  </ol>
                  <pre>
                    {JSON.stringify(
                      {
                        registries: Object.fromEntries(
                          hostDraft.proposedRegistries
                            .filter(
                              (r) =>
                                !host.policy?.approvedRegistries.includes(r),
                            )
                            .map((r) => [r, {}]),
                        ),
                      },
                      null,
                      2,
                    )}
                  </pre>
                  <p>
                    Format validation does not establish trust in an endpoint.
                    Review ownership and purpose of each hostname before
                    approving it. Empty policies allow public HTTPS registry
                    reads only. If authentication or a blob redirect is
                    required, independently verify exact HTTPS token realm URLs
                    and exact redirect hostnames before adding them locally.
                    Never copy credentials into Hostboard. Do not use wildcards
                    or broaden permissions based only on an error response.
                  </p>
                  <ol start={3}>
                    <li>
                      Validate the JSON and retain root:root ownership and mode
                      0600. Keep collector, reader and systemd permissions
                      unchanged.
                    </li>
                    <li>
                      Wait for the independent collector timer and Hostboard’s
                      next snapshot read, then check the collector-confirmed
                      list and collection timestamp here. “Refresh Status” on
                      Updates rereads the snapshot; it does not run collection.
                      Proposals remain pending until the host reports approval.
                    </li>
                  </ol>
                </details>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
