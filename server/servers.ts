import { randomUUID } from "node:crypto";
import express, { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import { authorization, type AdminConfig } from "./admin.js";
import { HostSchema, type HostConfig } from "./config.js";
import { AgentTrust } from "./agent-policy.js";
import { Agent, agentDiagnostic, empty } from "./netdata.js";
import type { Configuration } from "./settings.js";
import type { Host } from "../src/types.js";
import type {
  ManagedServer,
  ServerDiscovery,
  ServerGroup,
} from "../src/server-types.js";

const Connection = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: HostSchema.shape.url,
    node: z
      .string()
      .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
      .optional(),
  })
  .strict();
const Revision = z.number().int().positive();
const Input = z
  .object({
    revision: Revision,
    connection: Connection,
    enabled: z.boolean(),
    groupId: z.string().max(64).nullable(),
    testId: z.string().max(64).optional(),
  })
  .strict();
type Ticket = {
  id?: string;
  url: string;
  guid: string;
  discovery: ServerDiscovery;
  time: number;
};
export class Servers {
  private agents = new Map<string, Agent>();
  private snapshots = new Map<string, Host>();
  private tickets = new Map<string, Ticket>();
  private testing = 0;
  private recordCache = new Map<string, ManagedServer>();
  constructor(
    readonly store: Configuration,
    readonly trust: AgentTrust,
    seed: HostConfig[],
    private loggingHosts: string[] = [],
  ) {
    if (
      !store.db
        .prepare("SELECT value FROM metadata WHERE key='serversImported'")
        .get()
    ) {
      store.atomic(() => {
        for (const h of seed)
          store.db
            .prepare("INSERT INTO server_registry(id,definition) VALUES(?,?)")
            .run(
              h.id,
              JSON.stringify({
                id: h.id,
                name: h.name,
                url: new URL(h.url).origin,
                node: h.node,
              }),
            );
        store.db
          .prepare("INSERT INTO metadata VALUES('serversImported','1')")
          .run();
      });
    }
    // Refuse corrupt persisted connection definitions at startup.
    for (const r of this.records())
      HostSchema.parse({ id: r.id, name: r.name, url: r.url, node: r.node });
  }
  private record(id: string): ManagedServer | undefined {
    const cached = this.recordCache.get(id);
    if (cached) return cached;
    const r = this.store.db
      .prepare("SELECT * FROM server_registry WHERE id=?")
      .get(id) as any;
    if (!r) return;
    const value: ManagedServer = {
      ...JSON.parse(r.definition),
      guid: r.guid,
      enabled: !!r.enabled,
      archived: !!r.archived,
      groupId: r.groupId,
      discovery: r.discovery ? JSON.parse(r.discovery) : null,
      lastSeen: r.lastSeen,
    };
    this.recordCache.set(id, value);
    return value;
  }
  records(): ManagedServer[] {
    return this.ids().map((id) => this.record(id)!);
  }
  ids() {
    return (
      this.store.db
        .prepare("SELECT id FROM server_registry ORDER BY rowid")
        .all() as { id: string }[]
    ).map((r) => r.id);
  }
  groups(): ServerGroup[] {
    return this.store.db
      .prepare("SELECT * FROM server_groups ORDER BY name COLLATE NOCASE")
      .all() as unknown as ServerGroup[];
  }
  setLoggingHosts(ids: string[]) {
    this.loggingHosts = ids;
  }
  private remember(id: string, value: ServerDiscovery) {
    const old = id ? this.record(id) : undefined;
    if (!old || !old.enabled || old.archived)
      throw Error("Configured node is no longer monitored");
    if (old.guid && old.guid !== value.guid)
      throw Error("Unexpected node identity");
    if (this.records().some((r) => r.id !== id && r.guid === value.guid))
      throw Error("Node already registered");
    // Callback belongs to this connection generation; never update a replacement.
    this.store.db
      .prepare(
        "UPDATE server_registry SET guid=?,discovery=?,lastSeen=? WHERE id=?",
      )
      .run(value.guid, JSON.stringify(value), new Date().toISOString(), id);
    this.recordCache.delete(id);
  }
  agent(id: string): Agent | undefined {
    const r = this.record(id);
    if (!r || !r.enabled || r.archived) return;
    const config = {
      id: r.id,
      name: r.name,
      url: r.url,
      node: r.guid || r.node,
    };
    let agent = this.agents.get(id);
    if (
      !agent ||
      agent.config.url !== config.url ||
      agent.config.node !== config.node
    ) {
      const generation = new Agent(config, this.trust, (value) => {
        const current = this.record(id);
        if (!current || current.url !== config.url || current.node !== r.node)
          throw Error("Unexpected node identity");
        this.remember(id, value);
        generation.config.node = value.guid;
      });
      agent = generation;
      this.agents.set(id, agent);
    }
    agent.config.name = r.name;
    return agent;
  }
  async current(id: string) {
    const r = this.record(id)!;
    const agent = this.agent(id);
    let host = agent
      ? { ...(await agent.current()) }
      : empty(
          { id, name: r.name, url: r.url, node: r.node },
          r.archived
            ? "Archived; monitoring has stopped. Historical references are retained."
            : "Monitoring disabled. Service checks and log adapters are configured independently.",
          r.lastSeen,
        );
    const latest = this.record(id)!;
    if (agent?.lastCommunication && latest.enabled && !latest.archived) {
      this.store.db
        .prepare("UPDATE server_registry SET lastSeen=? WHERE id=?")
        .run(agent.lastCommunication, id);
      this.recordCache.delete(id);
    }
    if ((!latest.enabled || latest.archived) && agent)
      host = empty(
        { id, name: latest.name, url: latest.url, node: latest.node },
        latest.archived
          ? "Archived; monitoring has stopped. Historical references are retained."
          : "Monitoring disabled. Service checks and log adapters are configured independently.",
        latest.lastSeen,
      );
    host.discovery = latest.discovery || undefined;
    host.enabled = latest.enabled;
    host.archived = latest.archived;
    host.groupId = latest.groupId;
    host.groupName =
      this.groups().find((g) => g.id === latest.groupId)?.name || null;
    host.lastCommunication = agent?.lastCommunication || latest.lastSeen;
    host.loggingConfigured = this.loggingHosts.includes(id);
    host.name = latest.name;
    if (latest.discovery && !agent) {
      host.hostname = latest.discovery.hostname;
      host.os = latest.discovery.os;
      host.version = latest.discovery.version;
      host.cores = latest.discovery.cores;
    }
    this.snapshots.set(id, host);
    return host;
  }
  async fleet() {
    return Promise.all(
      this.ids().map(async (id) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.current(id),
            new Promise<Host>((resolve) => {
              timer = setTimeout(() => {
                const r = this.record(id)!,
                  previous = this.snapshots.get(id);
                resolve({
                  ...(previous ||
                    empty(
                      { id, name: r.name, url: r.url, node: r.node },
                      "",
                      r.lastSeen,
                    )),
                  name: r.name,
                  status: "stale",
                  enabled: r.enabled,
                  archived: r.archived,
                  groupId: r.groupId,
                  groupName:
                    this.groups().find((g) => g.id === r.groupId)?.name || null,
                  discovery: r.discovery || undefined,
                  error:
                    "Agent refresh is still in progress. Other servers continue reporting; retry shortly.",
                });
              }, 1500);
              timer.unref();
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }
  private commit(
    revision: number,
    actor: string,
    action: string,
    fn: () => void,
  ) {
    this.store.atomic(() => {
      if (revision !== this.store.revision())
        throw Object.assign(
          Error("Configuration changed elsewhere. Reload before saving."),
          { status: 409 },
        );
      fn();
      this.store.bump();
      this.store.audit(actor, action);
    });
    this.recordCache.clear();
  }
  api(admin: AdminConfig, auth = authorization(admin)) {
    const router = Router();
    router.use(auth.guard, express.json({ limit: "16kb" }));
    router.get("/", (_req, res) =>
      res.json({
        revision: this.store.revision(),
        servers: this.records(),
        groups: this.groups(),
      }),
    );
    router.post("/test", async (req, res) => {
      const { connection, id } = z
        .object({ connection: Connection, id: z.string().max(64).optional() })
        .strict()
        .parse(req.body);
      if (id && !this.ids().includes(id)) throw Error("Unknown server");
      if (this.testing >= 3 || !this.store.limit("agent-test", 1)) {
        res
          .status(429)
          .json({
            error: "Wait a moment before testing another Agent connection.",
          });
        return;
      }
      this.testing++;
      try {
        const agent = new Agent(
          {
            id: id || "discovery",
            name: connection.name,
            url: connection.url,
            node: connection.node || "discovery",
          },
          this.trust,
        );
        const nodes = await agent.nodes();
        const existing = id ? this.record(id) : undefined;
        const selector =
          connection.node ||
          existing?.guid ||
          (nodes.length === 1 ? nodes[0].guid : undefined);
        if (!selector) {
          res.json({
            nodes,
            message:
              "This Agent exposes several nodes. Choose the machine to register, then test again.",
          });
          return;
        }
        agent.config.node = selector;
        const discovery = await agent.discover();
        if (existing?.guid && existing.guid !== discovery.guid)
          throw Error("Unexpected node identity");
        if (
          this.records().some((r) => r.id !== id && r.guid === discovery.guid)
        )
          throw Error("Node already registered");
        // Also reserve unresolved migrated selectors to avoid registering them twice.
        if (
          this.records().some(
            (r) =>
              r.id !== id &&
              !r.guid &&
              nodes.some(
                (n) =>
                  n.guid === discovery.guid &&
                  [n.guid, n.nodeId, n.hostname].includes(r.node),
              ),
          )
        )
          throw Error("Node already registered");
        const testId = randomUUID();
        for (const [key, ticket] of this.tickets)
          if (Date.now() - ticket.time > 600_000) this.tickets.delete(key);
        if (this.tickets.size >= 100)
          this.tickets.delete(this.tickets.keys().next().value!);
        this.tickets.set(testId, {
          id,
          url: new URL(connection.url).origin,
          guid: discovery.guid,
          discovery,
          time: Date.now(),
        });
        res.json({
          nodes,
          discovery,
          testId,
          message:
            "Connection verified. Review the discovered node before saving.",
        });
      } catch (e) {
        const diagnostic = agentDiagnostic(e);
        res
          .status(422)
          .json({ error: diagnostic.message, diagnostic: diagnostic.code });
      } finally {
        this.testing--;
      }
    });
    const save = (id: string | undefined, body: unknown, actor: string) => {
      const data = Input.parse(body),
        old = id ? this.record(id) : undefined;
      if (id && !old) throw Error("Unknown server");
      const url = new URL(data.connection.url).origin;
      const changed =
        !old ||
        old.url !== url ||
        (data.connection.node &&
          ![old.node, old.guid].includes(data.connection.node)) ||
        (!old.guid && data.enabled);
      const candidate = data.testId ? this.tickets.get(data.testId) : undefined;
      const ticket =
        candidate &&
        candidate.id === id &&
        candidate.url === url &&
        (!data.connection.node || data.connection.node === candidate.guid) &&
        Date.now() - candidate.time <= 600_000
          ? candidate
          : undefined;
      if (changed && !ticket)
        throw Error(
          "Test this connection and review its node before saving. Connection tests expire after ten minutes.",
        );
      const guid = changed ? ticket!.guid : old!.guid,
        serverId = id || `server-${randomUUID()}`;
      this.commit(
        data.revision,
        actor,
        `${old ? "Updated" : "Added"} server ${serverId}`,
        () => {
          if (!old && this.records().length >= 100)
            throw Error(
              "Maximum of 100 registered servers, including archives",
            );
          if (data.groupId && !this.groups().some((g) => g.id === data.groupId))
            throw Error("Choose an existing group");
          if (
            guid &&
            this.records().some((r) => r.id !== id && r.guid === guid)
          )
            throw Error(
              "Node already registered; restore its existing registration",
            );
          const definition = {
            id: serverId,
            name: data.connection.name,
            url,
            node: guid || old!.node,
          };
          this.store.db
            .prepare(
              `INSERT INTO server_registry(id,definition,guid,enabled,archived,groupId,discovery,lastSeen) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,guid=excluded.guid,enabled=excluded.enabled,archived=0,groupId=excluded.groupId,discovery=excluded.discovery,lastSeen=excluded.lastSeen`,
            )
            .run(
              serverId,
              JSON.stringify(definition),
              guid || null,
              Number(data.enabled),
              data.groupId,
              ticket
                ? JSON.stringify(ticket.discovery)
                : old?.discovery
                  ? JSON.stringify(old.discovery)
                  : null,
              ticket
                ? new Date(ticket.time).toISOString()
                : old?.lastSeen || null,
            );
        },
      );
      this.agents.get(serverId)?.stop();
      this.agents.delete(serverId);
      if (data.testId) this.tickets.delete(data.testId);
      return { id: serverId, revision: this.store.revision() };
    };
    router.post("/", (req, res) =>
      res.status(201).json(save(undefined, req.body, res.locals.actor)),
    );
    router.put("/:id", (req, res) =>
      res.json(save(req.params.id, req.body, res.locals.actor)),
    );
    router.post("/:id/archive", (req, res) => {
      const data = z
        .object({ revision: Revision, confirm: z.literal("ARCHIVE") })
        .strict()
        .parse(req.body);
      this.commit(
        data.revision,
        res.locals.actor,
        `Archived server ${req.params.id}`,
        () => {
          if (!this.ids().includes(req.params.id))
            throw Error("Unknown server");
          this.store.db
            .prepare(
              "UPDATE server_registry SET enabled=0,archived=1 WHERE id=?",
            )
            .run(req.params.id);
        },
      );
      this.agents.get(req.params.id)?.stop();
      this.agents.delete(req.params.id);
      res.json({ revision: this.store.revision() });
    });
    router.post("/groups", (req, res) => {
      const data = z
        .object({
          revision: Revision,
          name: z.string().trim().min(1).max(80),
          id: z.string().max(64).optional(),
        })
        .strict()
        .parse(req.body);
      this.commit(data.revision, res.locals.actor, "Saved server group", () => {
        if (data.id && !this.groups().some((g) => g.id === data.id))
          throw Error("Unknown group");
        if (!data.id && this.groups().length >= 50)
          throw Error("Maximum of 50 groups");
        if (
          this.groups().some(
            (g) =>
              g.id !== data.id &&
              g.name.toLowerCase() === data.name.toLowerCase(),
          )
        )
          throw Error("Group name already exists");
        this.store.db
          .prepare(
            "INSERT INTO server_groups VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
          )
          .run(data.id || randomUUID(), data.name);
      });
      res.json({ revision: this.store.revision() });
    });
    router.post("/groups/:id/remove", (req, res) => {
      const { revision } = z
        .object({ revision: Revision })
        .strict()
        .parse(req.body);
      this.commit(
        revision,
        res.locals.actor,
        "Removed unused server group",
        () => {
          if (this.records().some((r) => r.groupId === req.params.id))
            throw Error(
              "Move all servers out of this group before removing it",
            );
          this.store.db
            .prepare("DELETE FROM server_groups WHERE id=?")
            .run(req.params.id);
        },
      );
      res.json({ revision: this.store.revision() });
    });
    router.use(((e, _req, res, _next) => {
      res
        .status(e.status === 409 ? 409 : 400)
        .json({
          error:
            e instanceof z.ZodError
              ? "Invalid server configuration. Use an HTTP(S) origin without credentials, paths, queries or fragments."
              : e instanceof Error &&
                  /^(Configuration changed|Unknown|Choose|Maximum|Group name|Move all|Test this|Node already)/.test(
                    e.message,
                  )
                ? e.message
                : "Unable to update server configuration",
        });
    }) as ErrorRequestHandler);
    return router;
  }
}
