import { useEffect, useState } from "react";
import type { Host } from "./types";
import type { MonitorView } from "./monitor-types";
import type { Settings as Values } from "../server/settings";
import {
  useDisplay,
  saveDisplay,
  displayDefaults,
  type Display,
} from "./display";
import { Settings as OperationalStatus, date } from "./Monitoring";
interface Definition {
  name: string;
  hostId: string;
  group: "Applications" | "Infrastructure";
  type: "http" | "tcp";
  url?: string;
  address?: string;
  port?: number;
  expectedStatuses?: number[];
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  severity: "warning" | "critical";
  notify: boolean;
  cooldownSeconds: number;
}
interface Service {
  id: string;
  definition: Definition;
  enabled: boolean;
  deleted: boolean;
  protected: boolean;
}
interface Config {
  revision: number;
  settings: Values;
  effectiveRecipients: string[];
  checks: Service[];
  targets: { host: string; port: number }[];
  mailTests: { time: number; state: string }[];
}
const tabs = [
  "General",
  "Services",
  "Notifications",
  "Data & History",
  "System Status",
] as const;
export async function adminRequest(
  path: string,
  body: unknown,
  method = "POST",
) {
  const r = await fetch(`/api/admin/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Hostboard-Request": "1" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed");
  return data;
}
function GeneralFields({
  value,
  onChange,
}: {
  value: Display;
  onChange: (v: Display) => void;
}) {
  return (
    <div className="settings-fields">
      <label>
        Dashboard refresh (seconds)
        <input
          aria-label="Dashboard refresh (seconds)"
          type="number"
          min="10"
          max="300"
          required
          value={value.refreshSeconds}
          onChange={(e) =>
            onChange({ ...value, refreshSeconds: Number(e.target.value) })
          }
        />
        <small>10–300 seconds. Monitoring checks run independently.</small>
      </label>
      <label>
        Temperature units
        <select
          aria-label="Temperature units"
          value={value.temperature}
          onChange={(e) =>
            onChange({ ...value, temperature: e.target.value as "C" | "F" })
          }
        >
          <option value="C">Celsius</option>
          <option value="F">Fahrenheit</option>
        </select>
      </label>
      <label>
        Default chart range
        <select
          aria-label="Default chart range"
          value={value.range}
          onChange={(e) =>
            onChange({ ...value, range: e.target.value as Display["range"] })
          }
        >
          {["15m", "1h", "6h", "24h"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Default landing page
        <select
          aria-label="Default landing page"
          value={value.landing}
          onChange={(e) =>
            onChange({
              ...value,
              landing: e.target.value as Display["landing"],
            })
          }
        >
          {["overview", "servers", "services", "issues", "settings"].map(
            (x) => (
              <option key={x}>{x}</option>
            ),
          )}
        </select>
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={value.compact}
          onChange={(e) => onChange({ ...value, compact: e.target.checked })}
        />
        Compact Overview spacing
      </label>
    </div>
  );
}
export function Settings({
  data,
  error,
  hosts,
}: {
  data?: MonitorView;
  error: boolean;
  hosts: Host[];
}) {
  const display = useDisplay(),
    [personal, setPersonal] = useState(display),
    [scope, setScope] = useState("personal");
  const [tab, setTab] = useState<(typeof tabs)[number]>("General"),
    [session, setSession] = useState<{ admin: boolean; configured: boolean }>(),
    [config, setConfig] = useState<Config>(),
    [draft, setDraft] = useState<Values>(),
    [service, setService] = useState<Service | null>(),
    [message, setMessage] = useState(""),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [system, setSystem] = useState<any>(),
    [recipientText, setRecipientText] = useState("");
  async function reload() {
    const r = await fetch("/api/admin/config");
    if (!r.ok) throw Error("Administrator configuration unavailable");
    const c: Config = await r.json();
    setConfig(c);
    setDraft(c.settings);
    setRecipientText(c.settings.notifications.recipients.join(", "));
    return c;
  }
  useEffect(() => {
    setPersonal(display);
  }, [display]);
  useEffect(() => {
    let active = true;
    void fetch("/api/session")
      .then((r) => r.json())
      .then(async (s) => {
        if (!active) return;
        setSession(s);
        if (s.admin) await reload();
      })
      .catch(() => setFailure("Unable to load configuration status"));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (tab !== "System Status") return;
    const controller = new AbortController();
    async function load() {
      try {
        const r = await fetch("/api/system", {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (!r.ok) throw Error();
        const value = await r.json();
        if (!controller.signal.aborted) setSystem(value);
      } catch {
        if (!controller.signal.aborted) {
          setSystem(undefined);
          setFailure("System status unavailable");
        }
      }
    }
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [tab]);

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(config?.settings) ||
    JSON.stringify(personal) !== JSON.stringify(display) ||
    !!service;
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const navigate = (e: Event) => {
      if (!confirm("Discard unsaved settings changes?")) e.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("hostboard:navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("hostboard:navigate", navigate);
    };
  }, [dirty]);
  async function action(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      const result = await fn();
      if (success && result !== false) setMessage(success);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft || !config) return false;
    const reducing =
      draft.retention.sampleDays < config.settings.retention.sampleDays;
    if (
      reducing &&
      !confirm(
        "Reduce raw sample retention? Older samples will be removed during hourly cleanup. A SQLite recovery backup will be created first. Incident history is retained.",
      )
    )
      return false;
    await adminRequest(
      "settings",
      {
        revision: config.revision,
        settings: draft,
        ...(reducing ? { confirmRetention: true } : {}),
      },
      "PUT",
    );
    await reload();
    window.dispatchEvent(new Event("hostboard:display"));
  }
  function changeTab(t: (typeof tabs)[number]) {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setDraft(config?.settings);
    setPersonal(display);
    setService(undefined);
    setTab(t);
    setFailure("");
    setMessage("");
  }
  const buttons = (
    saveAction: () => void,
    reset: () => void,
    cancel: () => void,
  ) => (
    <div className="settings-actions">
      <button
        className="primary-button"
        type="submit"
        disabled={busy}
        onClick={saveAction}
      >
        Save changes
      </button>
      <button type="button" onClick={cancel} disabled={busy}>
        Cancel
      </button>
      <button type="button" onClick={reset} disabled={busy}>
        Restore defaults
      </button>
      <span className="muted">{dirty ? "Unsaved changes" : ""}</span>
    </div>
  );
  const newService = (): Service => ({
    id: "",
    enabled: true,
    deleted: false,
    protected: false,
    definition: {
      name: "",
      hostId: hosts[0]?.id ?? "",
      group: "Applications",
      type: "http",
      url: "",
      expectedStatuses: [200],
      intervalSeconds: 60,
      timeoutMs: 5000,
      failureThreshold: 3,
      severity: "critical",
      notify: true,
      cooldownSeconds: 900,
    },
  });
  const selected = service?.definition;
  function patch(p: Partial<Definition>) {
    if (service)
      setService({ ...service, definition: { ...service.definition, ...p } });
  }
  async function saveService() {
    if (!service || !config) return;
    const { definition, enabled, id } = service;
    await adminRequest(
      id ? `checks/${id}` : "checks",
      { revision: config.revision, definition, enabled },
      id ? "PUT" : "POST",
    );
    await reload();
    setService(undefined);
  }
  return (
    <div className="settings-view">
      <p className="detail-description">
        Personalize this browser or manage application configuration.
      </p>
      {!session?.admin && (
        <p className="notice">
          {session?.configured
            ? "Read-only application configuration. Sign in through Cloudflare Access with an authorized administrator identity to make global changes."
            : "Application administration is locked. Configure a signed Cloudflare Access identity and explicit administrator allowlist on the server."}{" "}
          Personal preferences remain available.
        </p>
      )}
      {data?.notifications.failed ? (
        <p className="notice danger">
          Delivery needs attention ·{" "}
          <a href="#issues?type=notification">
            Investigate delivery failures →
          </a>
        </p>
      ) : null}
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {tabs.map((t) => (
          <button
            role="tab"
            key={t}
            aria-selected={tab === t}
            onClick={() => changeTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {failure && (
        <p className="notice danger" role="alert">
          {failure}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {tab === "General" && (
        <section className="monitor-panel">
          <h2>General preferences</h2>
          <div className="settings-scope">
            <label>
              Settings scope
              <select
                aria-label="Settings scope"
                value={scope}
                onChange={(e) => {
                  if (dirty && !confirm("Discard unsaved changes?")) return;
                  setScope(e.target.value);
                  setDraft(config?.settings);
                  setPersonal(display);
                }}
              >
                <option value="personal">This browser</option>
                {session?.admin && (
                  <option value="global">Application defaults</option>
                )}
              </select>
            </label>
          </div>
          <p className="muted">
            {scope === "personal"
              ? "Saved on this browser and device. Personal values override application defaults."
              : "Global defaults apply to browsers without personal overrides. Changes persist in SQLite."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (scope === "personal") {
                if (saveDisplay(personal))
                  setMessage("Personal preferences saved");
                else
                  setFailure(
                    "Browser storage is unavailable; preferences could not be saved",
                  );
              } else void action(save, "Application defaults saved");
            }}
          >
            <GeneralFields
              value={
                scope === "personal" ? personal : (draft?.general ?? display)
              }
              onChange={(v) =>
                scope === "personal"
                  ? setPersonal(v)
                  : draft && setDraft({ ...draft, general: v })
              }
            />
            {buttons(
              () => {},
              () =>
                scope === "personal"
                  ? setPersonal(displayDefaults)
                  : draft && setDraft({ ...draft, general: displayDefaults }),
              () => {
                setPersonal(display);
                setDraft(config?.settings);
                setMessage("Changes cancelled");
              },
            )}
          </form>
          {scope === "personal" && (
            <button
              className="text-link"
              onClick={() => {
                if (saveDisplay(null)) setMessage("Using application defaults");
                else
                  setFailure(
                    "Browser storage is unavailable; preferences could not be reset",
                  );
              }}
            >
              Use application defaults
            </button>
          )}
        </section>
      )}
      {tab === "Services" && (
        <section className="monitor-panel">
          <div className="settings-panel-heading">
            <h2>Service checks</h2>
            {session?.admin && service === undefined && (
              <button
                className="primary-button"
                onClick={() => setService(newService())}
              >
                Add service check
              </button>
            )}
          </div>
          <p className="muted">
            Edits retain check identities and history. Disabled checks do not
            run. Removed checks are archived and can be restored.
          </p>
          {!config && (
            <p>
              {data?.checks.length ?? "—"} checks configured. Private targets
              are visible only to administrators.
            </p>
          )}
          {config && service === undefined && (
            <div className="settings-service-list">
              {config.checks.map((c) => (
                <div key={c.id}>
                  <span>
                    <b>{c.definition.name}</b>
                    <small>
                      {c.definition.group ?? "Automatic group"} ·{" "}
                      {c.deleted
                        ? "Archived"
                        : !c.enabled
                          ? "Check disabled"
                          : (data?.checks.find((x) => x.id === c.id)?.reason ??
                            "Awaiting observation")}
                    </small>
                  </span>
                  <button onClick={() => setService(structuredClone(c))}>
                    {c.deleted ? "Restore / edit" : "Edit"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {service && selected && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(saveService, "Service configuration saved");
              }}
              className="service-editor"
            >
              <h3>{service.id ? "Edit service check" : "New service check"}</h3>
              {service.protected && (
                <p className="notice">
                  Deployment-managed authentication or watchdog integration is
                  preserved.
                </p>
              )}
              <div className="settings-fields">
                <label>
                  Friendly name
                  <input
                    aria-label="Friendly name"
                    required
                    maxLength={80}
                    value={selected.name}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
                <label>
                  Host
                  <select
                    aria-label="Host"
                    value={selected.hostId}
                    onChange={(e) => patch({ hostId: e.target.value })}
                  >
                    {hosts.map((h) => (
                      <option value={h.id} key={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Service group
                  <select
                    aria-label="Service group"
                    value={selected.group ?? "Applications"}
                    onChange={(e) =>
                      patch({ group: e.target.value as Definition["group"] })
                    }
                  >
                    <option>Applications</option>
                    <option>Infrastructure</option>
                  </select>
                </label>
                <label>
                  Check type
                  <select
                    aria-label="Check type"
                    disabled={service.protected}
                    value={selected.type}
                    onChange={(e) => {
                      const c = {
                        ...selected,
                        type: e.target.value as "http" | "tcp",
                      };
                      if (c.type === "tcp") {
                        delete c.url;
                        delete c.expectedStatuses;
                        c.address = "";
                        c.port = 443;
                      } else {
                        delete c.address;
                        delete c.port;
                        c.url = "";
                        c.expectedStatuses = [200];
                      }
                      setService({ ...service, definition: c });
                    }}
                  >
                    <option value="http">HTTP / HTTPS</option>
                    <option value="tcp">TCP connection</option>
                  </select>
                </label>
                {selected.type === "http" ? (
                  <>
                    <label className="wide-field">
                      URL
                      <input
                        aria-label="URL"
                        type="url"
                        required
                        value={selected.url ?? ""}
                        onChange={(e) => patch({ url: e.target.value })}
                      />
                      <small>
                        Approved destinations only. No credentials or query
                        strings.
                      </small>
                    </label>
                    <label>
                      Expected HTTP status
                      <input
                        aria-label="Expected HTTP status"
                        type="number"
                        required
                        min="100"
                        max="599"
                        value={selected.expectedStatuses?.[0] ?? 200}
                        onChange={(e) =>
                          patch({ expectedStatuses: [Number(e.target.value)] })
                        }
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      Hostname or address
                      <input
                        aria-label="Hostname or address"
                        required
                        value={selected.address ?? ""}
                        onChange={(e) => patch({ address: e.target.value })}
                      />
                    </label>
                    <label>
                      TCP port
                      <input
                        aria-label="TCP port"
                        type="number"
                        required
                        min="1"
                        max="65535"
                        value={selected.port ?? 443}
                        onChange={(e) =>
                          patch({ port: Number(e.target.value) })
                        }
                      />
                    </label>
                  </>
                )}
                <label>
                  Check interval (seconds)
                  <input
                    aria-label="Check interval (seconds)"
                    type="number"
                    min="10"
                    max="3600"
                    required
                    value={selected.intervalSeconds}
                    onChange={(e) =>
                      patch({ intervalSeconds: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Timeout (milliseconds)
                  <input
                    aria-label="Timeout (milliseconds)"
                    type="number"
                    min="100"
                    max="30000"
                    required
                    value={selected.timeoutMs}
                    onChange={(e) =>
                      patch({ timeoutMs: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Consecutive failures
                  <input
                    aria-label="Consecutive failures"
                    type="number"
                    min="1"
                    max="20"
                    required
                    value={selected.failureThreshold}
                    onChange={(e) =>
                      patch({ failureThreshold: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Severity
                  <select
                    aria-label="Severity"
                    value={selected.severity}
                    onChange={(e) =>
                      patch({
                        severity: e.target.value as Definition["severity"],
                      })
                    }
                  >
                    <option>warning</option>
                    <option>critical</option>
                  </select>
                </label>
                <label>
                  Notification cooldown (seconds)
                  <input
                    aria-label="Notification cooldown (seconds)"
                    type="number"
                    required
                    min="0"
                    max="86400"
                    value={selected.cooldownSeconds}
                    onChange={(e) =>
                      patch({ cooldownSeconds: Number(e.target.value) })
                    }
                  />
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={service.enabled}
                    onChange={(e) =>
                      setService({ ...service, enabled: e.target.checked })
                    }
                  />
                  Check enabled
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={selected.notify}
                    onChange={(e) => patch({ notify: e.target.checked })}
                  />
                  Hostboard notifications for this check
                </label>
              </div>
              <p className="muted">
                Latest result:{" "}
                {data?.checks.find((c) => c.id === service.id)?.reason ??
                  "No observations yet"}
              </p>
              <details>
                <summary>Permitted destinations</summary>
                <p className="muted">
                  A deployment administrator must approve any new destination
                  and its resolved addresses. These restrictions cannot be
                  changed from the dashboard.
                </p>
                {config?.targets.map((t, i) => (
                  <code key={i}>
                    {t.host}:{t.port}{" "}
                  </code>
                ))}
              </details>
              <div className="settings-actions">
                <button
                  type="submit"
                  className="primary-button"
                  disabled={busy}
                >
                  Save service
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setService(undefined);
                    setFailure("");
                    setMessage("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const result = await adminRequest("checks/test", {
                        definition: selected,
                        ...(service.id ? { id: service.id } : {}),
                      });
                      if (result.ok !== true) throw Error(result.reason);
                      setMessage(
                        `Test passed: ${result.reason} · ${Math.round(result.responseMs)} ms`,
                      );
                    }, "")
                  }
                >
                  Test configuration
                </button>
                {service.id && !service.deleted && (
                  <button
                    type="button"
                    className="danger-text"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${selected.name}? Checks will stop. History is retained and the check can be restored.`,
                        )
                      )
                        void action(async () => {
                          await adminRequest(`checks/${service.id}/archive`, {
                            revision: config?.revision,
                            confirm: "ARCHIVE",
                          });
                          await reload();
                          setService(undefined);
                        }, "Service archived; history retained");
                    }}
                  >
                    Remove check
                  </button>
                )}
              </div>
            </form>
          )}
        </section>
      )}
      {tab === "Notifications" && (
        <>
          <OperationalStatus data={data} error={error} />
          {draft && (
            <section className="monitor-panel">
              <h2>Hostboard notifications</h2>
              <p className="muted">
                Controls service incidents only. Netdata’s native hook and the
                independent watchdog retain their own recipients, severity and
                cooldowns. SMTP credentials remain deployment-managed.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(save, "Notification preferences saved");
                }}
              >
                <div className="settings-fields">
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={draft.notifications.enabled}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            enabled: e.target.checked,
                          },
                        })
                      }
                    />
                    Enable service-incident notifications
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={draft.notifications.recovery}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            recovery: e.target.checked,
                          },
                        })
                      }
                    />
                    Send recovery notifications
                  </label>
                  <label className="wide-field">
                    Recipient emails
                    <input
                      aria-label="Recipient emails"
                      value={recipientText}
                      onChange={(e) => {
                        setRecipientText(e.target.value);
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            recipients: e.target.value
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          },
                        });
                      }}
                    />
                    <small>
                      Comma-separated. Empty uses deployment recipients:{" "}
                      {config?.effectiveRecipients.join(", ") ||
                        "not configured"}
                      .
                    </small>
                  </label>
                  <label>
                    Minimum severity
                    <select
                      aria-label="Minimum severity"
                      value={draft.notifications.minimumSeverity}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            minimumSeverity: e.target.value as
                              | "warning"
                              | "critical",
                          },
                        })
                      }
                    >
                      <option>warning</option>
                      <option>critical</option>
                    </select>
                  </label>
                  <label>
                    Minimum cooldown (seconds)
                    <input
                      aria-label="Minimum cooldown (seconds)"
                      type="number"
                      required
                      min="0"
                      max="86400"
                      value={draft.notifications.cooldownSeconds}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            cooldownSeconds: Number(e.target.value),
                          },
                        })
                      }
                    />
                    <small>
                      The larger of this and each check’s cooldown applies.
                    </small>
                  </label>
                </div>
                {buttons(
                  () => {},
                  () => {
                    setRecipientText("");
                    setDraft({
                      ...draft,
                      notifications: {
                        enabled: true,
                        recipients: [],
                        minimumSeverity: "warning",
                        cooldownSeconds: 0,
                        recovery: true,
                      },
                    });
                  },
                  () => {
                    setDraft(config?.settings);
                    setRecipientText(
                      config?.settings.notifications.recipients.join(", ") ??
                        "",
                    );
                  },
                )}
              </form>
              <button
                disabled={busy || dirty}
                onClick={() =>
                  void action(async () => {
                    const result = await adminRequest("mail-test", {});
                    await reload();
                    setMessage(result.message);
                  }, "SMTP accepted the test email. Verify inbox receipt.")
                }
              >
                Send test email
              </button>
              <p className="small muted">
                Uses saved recipients, even if incident notifications are
                disabled. Limited to one test per minute.
              </p>
              <ul>
                {config?.mailTests.map((t, i) => (
                  <li key={i}>
                    {date(t.time)} · {t.state}
                  </li>
                ))}
              </ul>
              <div className="delivery-list">
                {data?.incidents
                  .flatMap((i) =>
                    i.notifications
                      .filter((n) => n.error)
                      .map((n) => (
                        <p key={n.id}>
                          {i.name}: {n.error} · {date(n.lastAttempt)}
                        </p>
                      )),
                  )
                  .slice(0, 10)}
              </div>
            </section>
          )}
        </>
      )}
      {tab === "Data & History" && (
        <section className="monitor-panel">
          <h2>Data & History</h2>
          <p>
            Hostboard retains raw HTTP/TCP observations in SQLite. Netdata
            manages its own metric retention independently.
          </p>
          <p>
            Incidents and notification delivery history are retained
            indefinitely. Archiving checks preserves their history.
          </p>
          {draft ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(save, "Retention preferences saved");
              }}
            >
              <div className="settings-fields">
                <label>
                  Raw sample retention (days)
                  <input
                    aria-label="Raw sample retention (days)"
                    type="number"
                    min="30"
                    max="365"
                    required
                    value={draft.retention.sampleDays}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        retention: {
                          sampleDays: Number(e.target.value),
                          incidentDays: 0,
                        },
                      })
                    }
                  />
                  <small>
                    30–365 days. Hourly cleanup removes only samples older than
                    this window. Reducing it eventually removes older samples;
                    it cannot restore previously expired data.
                  </small>
                </label>
              </div>
              {buttons(
                () => {},
                () =>
                  setDraft({
                    ...draft,
                    retention: { sampleDays: 30, incidentDays: 0 },
                  }),
                () => setDraft(config?.settings),
              )}
            </form>
          ) : (
            <p>
              Effective raw retention: {data?.retentionDays ?? "Unavailable"}{" "}
              days.
            </p>
          )}
          <p className="small muted">
            No incident deletion or database reset is offered here. Back up
            SQLite using its backup API before maintenance. Deployments retain a
            consistent pre-deployment backup.
          </p>
        </section>
      )}
      {tab === "System Status" && (
        <>
          <OperationalStatus data={data} error={error} />
          <section className="monitor-panel">
            <h2>System Status</h2>
            {system ? (
              <>
                <p>
                  Hostboard v{system.version} · {system.activeChecks} active
                  service checks · {system.servers.length} monitored servers
                </p>
                <p>
                  Netdata connectivity:{" "}
                  {system.servers
                    .map((h: any) => `${h.name}: ${h.status}`)
                    .join(" · ")}
                </p>
                <p>
                  Independent watchdog:{" "}
                  {system.watchdogs.length
                    ? system.watchdogs
                        .map(
                          (w: any) =>
                            `${w.name}: ${w.state === "up" ? "fresh" : w.state} · ${date(w.checkedAt)}`,
                        )
                        .join(" · ")
                    : "Unavailable; no watchdog freshness integration configured"}
                </p>
              </>
            ) : (
              <p>System information unavailable or loading.</p>
            )}
            <p className="muted">
              Netdata and watchdog notification configuration and transport
              status are independently managed. A fresh watchdog endpoint does
              not prove email delivery.
            </p>
            <a
              className="text-link"
              href="https://github.com/KLCaron/hostboard/releases"
              target="_blank"
              rel="noreferrer"
            >
              Release information ↗
            </a>
          </section>
        </>
      )}
    </div>
  );
}
