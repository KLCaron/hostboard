import { useEffect, useState } from "react";
import { adminRequest } from "./Settings";
import type { Host } from "./types";
import type {
  DiscoveredNode,
  ManagedServer,
  ServerDiscovery,
  ServerGroup,
} from "./server-types";
export function DiscoverySummary({ value }: { value: ServerDiscovery }) {
  return (
    <div className="server-discovery">
      <h3>{value.hostname}</h3>
      <dl className="host-information">
        <dt>Machine GUID</dt>
        <dd>
          <code>{value.guid}</code>
        </dd>
        <dt>Operating system</dt>
        <dd>{value.os || "Not reported"}</dd>
        <dt>Kernel</dt>
        <dd>{value.kernel || "Not reported"}</dd>
        <dt>CPU</dt>
        <dd>
          {value.cpuModel || "Model not reported"} · {value.cores ?? "Unknown"}{" "}
          logical cores
        </dd>
        <dt>Physical memory</dt>
        <dd>
          {value.memoryBytes
            ? `${(value.memoryBytes / 1073741824).toLocaleString(undefined, { maximumFractionDigits: 1 })} GiB`
            : "Not reported"}
        </dd>
        <dt>Netdata version</dt>
        <dd>{value.version || "Not reported"}</dd>
        <dt>Available metrics</dt>
        <dd>
          {value.categories.join(" · ") ||
            "No common metric collectors reported"}
        </dd>
      </dl>
      {!!value.warnings.length && (
        <p className="notice">{value.warnings.join(" · ")}</p>
      )}
      <details>
        <summary>
          Metric and collector availability ({value.contexts.length} contexts)
        </summary>
        <p>Collectors: {value.collectors.join(", ") || "Not reported"}</p>
        <p>
          Filesystems:{" "}
          {value.filesystems
            .map((f) => `${f.mount} (${f.filesystem || "type not reported"})`)
            .join(", ") || "Not reported"}
        </p>
        <p>
          Network interfaces: {value.interfaces.join(", ") || "Not reported"}
        </p>
        <p>Temperature sensors: {value.sensors.join(", ") || "Not reported"}</p>
        <p className="small">
          {value.contexts.join(", ") || "No metric contexts reported"}
        </p>
        <p className="small muted">
          Discovered {new Date(value.discoveredAt).toLocaleString()}.
          Availability reflects the latest discovery; it does not guarantee
          fresh samples.
        </p>
      </details>
    </div>
  );
}
type Draft = {
  id?: string;
  name: string;
  url: string;
  node: string;
  enabled: boolean;
  groupId: string | null;
  archived?: boolean;
};
export function ServerSettings({
  admin,
  hosts,
  onDirty,
}: {
  admin: boolean;
  hosts: Host[];
  onDirty: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<{
    revision: number;
    servers: ManagedServer[];
    groups: ServerGroup[];
  }>();
  const [draft, setDraft] = useState<Draft>();
  const [nodes, setNodes] = useState<DiscoveredNode[]>([]);
  const [tested, setTested] = useState<{
    testId: string;
    discovery: ServerDiscovery;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [group, setGroup] = useState({ id: "", name: "" });
  async function reload() {
    const r = await fetch("/api/admin/servers");
    if (!r.ok)
      throw Error("Unable to load registered servers. Reload to retry.");
    setData(await r.json());
  }
  useEffect(() => {
    if (admin) void reload().catch((e) => setError(e.message));
  }, [admin]);
  useEffect(() => {
    onDirty(!!draft || !!group.name);
    return () => onDirty(false);
  }, [draft, group.name, onDirty]);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  function edit(server?: ManagedServer) {
    setDraft(
      server
        ? {
            id: server.id,
            name: server.name,
            url: server.url,
            node: server.guid || server.node,
            enabled: server.enabled,
            groupId: server.groupId,
            archived: server.archived,
          }
        : { name: "", url: "", node: "", enabled: true, groupId: null },
    );
    setNodes([]);
    setTested(undefined);
    setError("");
    setMessage("");
  }
  const original = data?.servers.find((s) => s.id === draft?.id);
  const needsTest =
    !!draft &&
    (!original ||
      original.url !== draft.url.replace(/\/$/, "") ||
      (original.guid || original.node) !== draft.node ||
      (!original.guid && draft.enabled));
  function connection() {
    return {
      name: draft!.name,
      url: draft!.url,
      ...(draft!.node ? { node: draft!.node } : {}),
    };
  }
  return (
    <section className="monitor-panel">
      <h2>Servers</h2>
      <p className="muted">
        Connect an already installed Netdata Agent to discover a machine and its
        metrics. Hostboard does not install software or create service checks.
        Docker log access requires a separately approved log adapter in Log
        Sources.
      </p>
      {!admin ? (
        <p className="notice">
          An authorized administrator is required to manage Agent connections.
        </p>
      ) : (
        <>
          {error && (
            <div className="notice danger" role="alert">
              {error}
              <p className="small">
                For networking help, see the operator’s server connection guide
                in{" "}
                <a
                  className="text-link"
                  href="https://github.com/KLCaron/hostboard/blob/main/docs/servers.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  docs/servers.md ↗
                </a>
                .
              </p>
            </div>
          )}
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
          {!data && !error && <p role="status">Loading registered servers…</p>}
          {data && (
            <>
              {!draft && (
                <button className="primary-button" onClick={() => edit()}>
                  Add server
                </button>
              )}
              <div className="settings-service-list">
                {data.servers.map((s) => {
                  const live = hosts.find((h) => h.id === s.id);
                  return (
                    <div key={s.id}>
                      <div>
                        <b>{s.name}</b>
                        <small>
                          {s.archived
                            ? "Archived · monitoring stopped"
                            : !s.enabled
                              ? "Monitoring disabled"
                              : live?.status || "Not checked yet"}{" "}
                          ·{" "}
                          {data.groups.find((g) => g.id === s.groupId)?.name ||
                            "Ungrouped"}
                        </small>
                        <small>
                          {s.discovery?.hostname || s.node}
                          {live?.error ? ` · ${live.error}` : ""}
                        </small>
                      </div>
                      <button
                        disabled={busy || !!draft}
                        onClick={() => edit(s)}
                      >
                        {s.archived ? "Restore / edit" : "Edit"}
                      </button>
                    </div>
                  );
                })}
                {!data.servers.length && (
                  <p>
                    No servers registered. Add a reachable Agent to begin
                    monitoring.
                  </p>
                )}
              </div>
              {draft && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await adminRequest(
                        draft.id ? `servers/${draft.id}` : "servers",
                        {
                          revision: data.revision,
                          connection: connection(),
                          enabled: draft.enabled,
                          groupId: draft.groupId,
                          ...(tested ? { testId: tested.testId } : {}),
                        },
                        draft.id ? "PUT" : "POST",
                      );
                      await reload();
                      setDraft(undefined);
                      setTested(undefined);
                      setMessage(
                        "Server saved. Monitoring follows its enabled setting; service checks and logging remain independently configured.",
                      );
                      window.dispatchEvent(new Event("hostboard:servers"));
                    });
                  }}
                >
                  <h3>{draft.id ? "Edit server" : "Add server"}</h3>
                  <div className="settings-fields">
                    <label>
                      Server name
                      <input
                        autoFocus
                        aria-label="Server name"
                        required
                        maxLength={80}
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Netdata Agent address
                      <input
                        aria-label="Netdata Agent address"
                        type="url"
                        required
                        placeholder="http://agent.example:19999"
                        value={draft.url}
                        onChange={(e) => {
                          setDraft({ ...draft, url: e.target.value, node: "" });
                          setTested(undefined);
                          setNodes([]);
                        }}
                      />
                      <small>
                        HTTP(S) origin only. No path, credentials or query. Use
                        an address reachable from the Hostboard backend;
                        localhost refers to its own container unless host
                        networking is configured.
                      </small>
                    </label>
                    <label>
                      Server group
                      <select
                        aria-label="Server group"
                        value={draft.groupId || ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            groupId: e.target.value || null,
                          })
                        }
                      >
                        <option value="">Ungrouped</option>
                        {data.groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(e) =>
                          setDraft({ ...draft, enabled: e.target.checked })
                        }
                      />
                      Monitoring enabled
                    </label>
                    {(nodes.length > 1 || draft.node) && (
                      <label>
                        Netdata node
                        {nodes.length ? (
                          <select
                            aria-label="Netdata node"
                            value={draft.node}
                            onChange={(e) => {
                              setDraft({ ...draft, node: e.target.value });
                              setTested(undefined);
                            }}
                          >
                            <option value="">Choose a discovered node</option>
                            {nodes.map((n) => (
                              <option key={n.guid} value={n.guid}>
                                {n.hostname} · {n.guid} · {n.state}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label="Netdata node"
                            value={draft.node}
                            readOnly
                          />
                        )}
                        <small>
                          Stable machine identity. Connection edits must retain
                          this machine’s GUID.
                        </small>
                      </label>
                    )}
                  </div>
                  <p className="small muted">
                    Only deployment-approved Agent destinations can be
                    contacted. A blocked destination requires operator approval
                    in private/agents.json; dashboard administrators cannot
                    expand that policy.
                  </p>
                  <div className="settings-actions">
                    <button
                      type="button"
                      disabled={busy || !draft.url || !draft.name}
                      aria-busy={busy}
                      onClick={() =>
                        void action(async () => {
                          setTested(undefined);
                          const r = await adminRequest("servers/test", {
                            connection: connection(),
                            ...(draft.id ? { id: draft.id } : {}),
                          });
                          setNodes(r.nodes);
                          setMessage(r.message);
                          if (r.discovery) {
                            setDraft({ ...draft, node: r.discovery.guid });
                            setTested({
                              testId: r.testId,
                              discovery: r.discovery,
                            });
                          }
                        })
                      }
                    >
                      {busy ? "Working…" : "Test connection"}
                    </button>
                    <button
                      type="submit"
                      className="primary-button"
                      disabled={busy || (needsTest && !tested)}
                    >
                      {draft.archived ? "Restore server" : "Save server"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDraft(undefined);
                        setError("");
                        setTested(undefined);
                      }}
                    >
                      Cancel
                    </button>
                    {draft.id && !draft.archived && (
                      <button
                        type="button"
                        className="danger-text"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              `Archive ${draft.name}? Agent monitoring stops. Historical references, service checks and log mappings are retained. You can restore this server later.`,
                            )
                          )
                            void action(async () => {
                              await adminRequest(
                                `servers/${draft.id}/archive`,
                                { revision: data.revision, confirm: "ARCHIVE" },
                              );
                              await reload();
                              setDraft(undefined);
                              setMessage("Server archived; history retained.");
                              window.dispatchEvent(
                                new Event("hostboard:servers"),
                              );
                            });
                        }}
                      >
                        Archive server
                      </button>
                    )}
                  </div>
                  {tested && (
                    <>
                      <p className="notice" role="status">
                        Connection verified. Saving registers this machine for
                        monitoring without changing the Agent.
                      </p>
                      <DiscoverySummary value={tested.discovery} />
                    </>
                  )}
                  {!tested && original?.discovery && (
                    <details>
                      <summary>Last discovered information</summary>
                      <DiscoverySummary value={original.discovery} />
                    </details>
                  )}
                </form>
              )}
              <details className="server-groups">
                <summary>Manage server groups</summary>
                <p className="muted small">
                  Each server can have one primary group. Move all servers,
                  including archived servers, out of a group before removing it.
                </p>
                {data.groups.map((g) => (
                  <div className="settings-actions" key={g.id}>
                    <b>{g.name}</b>
                    <button disabled={busy} onClick={() => setGroup(g)}>
                      Rename
                    </button>
                    <button
                      disabled={
                        busy || data.servers.some((s) => s.groupId === g.id)
                      }
                      onClick={() =>
                        void action(async () => {
                          await adminRequest(`servers/groups/${g.id}/remove`, {
                            revision: data.revision,
                          });
                          await reload();
                          setMessage("Unused group removed.");
                          window.dispatchEvent(new Event("hostboard:servers"));
                        })
                      }
                    >
                      Remove unused group
                    </button>
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await adminRequest("servers/groups", {
                        revision: data.revision,
                        name: group.name,
                        ...(group.id ? { id: group.id } : {}),
                      });
                      await reload();
                      setGroup({ id: "", name: "" });
                      setMessage("Server group saved.");
                      window.dispatchEvent(new Event("hostboard:servers"));
                    });
                  }}
                >
                  <label>
                    Group name
                    <input
                      aria-label="Group name"
                      required
                      maxLength={80}
                      value={group.name}
                      onChange={(e) =>
                        setGroup({ ...group, name: e.target.value })
                      }
                    />
                  </label>
                  <div className="settings-actions">
                    <button disabled={busy} type="submit">
                      {group.id ? "Save group name" : "Create group"}
                    </button>
                    {group.id && (
                      <button
                        type="button"
                        onClick={() => setGroup({ id: "", name: "" })}
                      >
                        Cancel rename
                      </button>
                    )}
                  </div>
                </form>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
