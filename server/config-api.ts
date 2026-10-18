import { Router, type ErrorRequestHandler } from "express";
import express from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CheckSchema, type CheckConfig } from "./check-config.js";
import { Configuration, SettingsSchema } from "./settings.js";
import { authorization, type AdminConfig } from "./admin.js";
import { TargetPolicy, type TargetRule } from "./targets.js";
import type { Monitor } from "./monitor.js";
import { probe } from "./probe.js";
export function synchronize(store: Configuration, monitor: Monitor) {
  const checks = store.checks();
  monitor.configure(
    store.runtime(),
    undefined,
    new Set(
      checks.filter((c) => !c.enabled || c.deleted).map((c) => c.definition.id),
    ),
    new Set(checks.filter((c) => c.deleted).map((c) => c.definition.id)),
  );
  monitor.preferences = store.settings();
  for (const id of monitor.disabled)
    monitor.db
      .prepare(
        "UPDATE incidents SET monitoringGap=1 WHERE id=(SELECT active FROM checks WHERE id=?)",
      )
      .run(id);
}
const editable = [
  "name",
  "hostId",
  "group",
  "type",
  "url",
  "address",
  "port",
  "expectedStatuses",
  "intervalSeconds",
  "timeoutMs",
  "failureThreshold",
  "severity",
  "notify",
  "cooldownSeconds",
] as const;
export function publicDefinition(c: CheckConfig) {
  return Object.fromEntries(
    editable
      .filter((k) => k in c)
      .map((k) => [k, (c as unknown as Record<string, unknown>)[k]]),
  );
}
const Input = z
  .object({
    revision: z.number().int().positive(),
    definition: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
  })
  .strict();
export function configAPI(
  store: Configuration,
  monitor: Monitor,
  admin: AdminConfig | null,
  hostIds: string[],
  auth = authorization(admin),
  fallbackTargets: TargetRule[] = [],
) {
  const router = Router(),
    policy = new TargetPolicy(admin?.targets ?? fallbackTargets);
  monitor.policy = policy;
  router.get("/preferences", (_req, res) =>
    res.json({ general: store.settings().general }),
  );
  router.get("/session", async (req, res) =>
    res.json({ admin: !!(await auth.identity(req)), configured: !!admin, mode: admin?.mode ?? "cloudflare" }),
  );
  router.use("/admin", auth.guard, express.json({ limit: "24kb" }));
  router.get("/admin/checks/:id/history", (req, res) => {
    const generation = req.query.generation;
    if (typeof generation !== "string" || !/^[1-9]\d{0,8}$/.test(generation)) {
      res.status(400).json({ error: "Choose a historical generation" });
      return;
    }
    const history = monitor.historyFor(req.params.id, Number(generation), undefined, true);
    if (!history) {
      res.status(404).json({ error: "Unknown check generation" });
      return;
    }
    res.json({ ...history, generations: monitor.generations(req.params.id, true) });
  });
  router.get("/admin/config", (_req, res) =>
    res.json({
      revision: store.revision(),
      settings: store.settings(),
      effectiveRecipients: monitor.delivery?.recipients ?? [],
      checks: store.checks().map((c) => ({
        id: c.definition.id,
        definition: publicDefinition(c.definition),
        enabled: c.enabled,
        deleted: c.deleted,
        protected:
          c.definition.type === "http" &&
          !!(c.definition.headersEnv || c.definition.watchdogHistory),
      })),
      targets: admin?.targets.map(({ host, port }) => ({ host, port })) ?? [],
      mailTests: store.db
        .prepare("SELECT time,state FROM mail_tests ORDER BY id DESC LIMIT 10")
        .all(),
    }),
  );
  function commit(
    revision: number,
    actor: string,
    action: string,
    change: () => void,
  ) {
    if (revision !== store.revision())
      throw Object.assign(
        Error("Configuration changed elsewhere. Reload before saving."),
        { status: 409 },
      );
    try {
      store.atomic(() => {
        change();
        synchronize(store, monitor);
        store.audit(actor, action);
      });
    } catch (e) {
      synchronize(store, monitor);
      throw e;
    }
  }
  router.put("/admin/settings", async (req, res) => {
    const { revision, settings, confirmRetention } = z
      .object({
        revision: z.number().int().positive(),
        settings: SettingsSchema,
        confirmRetention: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    if (settings.retention.sampleDays < store.settings().retention.sampleDays) {
      if (!confirmRetention)
        throw Error("Reducing retention requires explicit confirmation");
      await store.backup();
    }
    commit(revision, res.locals.actor, "Updated application settings", () =>
      store.saveSettings(settings),
    );
    res.json({ revision: store.revision() });
  });
  function definition(input: Record<string, unknown>, existing?: CheckConfig) {
    if (
      Object.keys(input).some(
        (k) => !editable.includes(k as (typeof editable)[number]),
      )
    )
      throw Error("Unsupported configuration field");
    if (
      existing?.type === "http" &&
      (existing.headersEnv || existing.watchdogHistory) &&
      input.type !== existing.type
    )
      throw Error("This deployment-managed integration must remain HTTP");
    const base =
      existing && input.type && input.type !== existing.type ? {} : existing;
    const c = CheckSchema.parse({
      ...base,
      ...input,
      id: existing?.id ?? `service-${randomUUID()}`,
    });
    if (
      existing?.type === "http" &&
      existing.headersEnv &&
      c.type === "http" &&
      new URL(c.url).origin !== new URL(existing.url).origin
    )
      throw Error(
        "Deployment-managed authentication cannot move to another origin",
      );
    if (!hostIds.includes(c.hostId)) throw Error("Choose a configured host");
    if (c.timeoutMs >= c.intervalSeconds * 1000)
      throw Error("Timeout must be shorter than the check interval");
    return c;
  }
  router.post("/admin/checks/test", async (req, res) => {
    if (!store.limit("endpoint-test", 5)) {
      res
        .status(429)
        .json({ error: "Wait five seconds between endpoint tests" });
      return;
    }
    const data = z
      .object({
        definition: z.record(z.string(), z.unknown()),
        id: z.string().optional(),
      })
      .strict()
      .parse(req.body);
    const existing = data.id
      ? store.checks().find((c) => c.definition.id === data.id)?.definition
      : undefined;
    if (data.id && !existing) throw Error("Unknown check");
    const c = definition(data.definition, existing);
    await policy.validate(c);
    const result = await probe(c, policy);
    const { watchdogHistory: _history, ...safe } = result;
    res.json(safe);
  });
  router.post("/admin/checks", async (req, res) => {
    const data = Input.parse(req.body);
    if (store.checks().length >= 100)
      throw Error("Maximum of 100 checks, including archived checks");
    const c = definition(data.definition);
    await policy.validate(c);
    commit(data.revision, res.locals.actor, `Added check ${c.id}`, () => {
      if (store.checks().length >= 100)
        throw Error("Maximum of 100 checks, including archived checks");
      store.saveCheck({ definition: c, enabled: data.enabled, deleted: false });
    });
    res.status(201).json({ id: c.id, revision: store.revision() });
  });
  router.put("/admin/checks/:id", async (req, res) => {
    const data = Input.parse(req.body),
      old = store.checks().find((c) => c.definition.id === req.params.id);
    if (!old) throw Error("Unknown check");
    const c = definition(data.definition, old.definition);
    await policy.validate(c);
    commit(data.revision, res.locals.actor, `Updated check ${c.id}`, () => {
      store.saveCheck({ definition: c, enabled: data.enabled, deleted: false });
    });
    res.json({ revision: store.revision() });
  });
  router.post("/admin/checks/:id/archive", (req, res) => {
    const data = z
      .object({
        revision: z.number().int().positive(),
        confirm: z.literal("ARCHIVE"),
      })
      .strict()
      .parse(req.body);
    const old = store.checks().find((c) => c.definition.id === req.params.id);
    if (!old) throw Error("Unknown check");
    commit(
      data.revision,
      res.locals.actor,
      `Archived check ${old.definition.id}`,
      () => store.saveCheck({ ...old, enabled: false, deleted: true }),
    );
    res.json({ revision: store.revision() });
  });
  router.post("/admin/mail-test", async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (!store.limit("mail-test", 60)) {
      res.status(429).json({ error: "Wait one minute between test emails" });
      return;
    }
    if (!monitor.delivery) {
      res.status(503).json({ error: "SMTP transport is not configured" });
      return;
    }
    let ok = false;
    try {
      await monitor.delivery.send({
        id: 0,
        messageKey: `test-${randomUUID()}`,
        subject: "[Hostboard] Configuration test",
        body: "This is a requested Hostboard test email. SMTP acceptance does not confirm inbox receipt.",
      });
      ok = true;
    } catch {
      /* Never expose transport errors. */
    }
    store.db
      .prepare("INSERT INTO mail_tests(time,state) VALUES(?,?)")
      .run(Date.now() / 1000, ok ? "SMTP accepted" : "Delivery failed");
    store.audit(res.locals.actor, "Requested test email");
    res.status(ok ? 200 : 502).json(
      ok
        ? { message: "SMTP accepted the test email. Verify inbox receipt." }
        : {
            error:
              "Test delivery failed. Check the deployment-managed SMTP configuration.",
          },
    );
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error.status === 409 ? 409 : 400).json({
      error:
        error instanceof z.ZodError
          ? "Invalid configuration: " +
            error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : ["entity.too.large", "entity.parse.failed"].includes(error.type)
            ? "Invalid JSON request"
            : error instanceof Error &&
                /^(Deployment-managed|Destination|Monitoring URLs|Unsupported configuration|This deployment|Choose a configured|Timeout must|Unknown check|Maximum of|Configuration changed|Reducing retention)/.test(
                  error.message,
                )
              ? error.message
              : "Configuration update failed; check the submitted values and server configuration",
    });
  };
  router.use(errors);
  return router;
}
