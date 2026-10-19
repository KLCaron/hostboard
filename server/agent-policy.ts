import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";
import { HostSchema, type HostConfig } from "./config.js";
import { TargetPolicy } from "./targets.js";
import { CheckSchema } from "./check-config.js";

const Endpoint = z
  .object({
    url: HostSchema.shape.url,
    addresses: z
      .array(z.string().refine((v) => !!isIP(v)))
      .min(1)
      .max(20),
    tokenEnv: HostSchema.shape.tokenEnv,
  })
  .strict();
export const AgentPolicySchema = z
  .object({ endpoints: z.array(Endpoint).max(200) })
  .strict();
export type AgentEndpoint = z.infer<typeof Endpoint>;
export class AgentTrust {
  readonly endpoints: AgentEndpoint[];
  private policies = new Map<string, TargetPolicy>();
  constructor(endpoints: AgentEndpoint[]) {
    this.endpoints = endpoints.map((e) => ({
      ...Endpoint.parse(e),
      url: new URL(e.url).origin,
    }));
    if (
      new Set(this.endpoints.map((e) => e.url)).size !== this.endpoints.length
    )
      throw Error("Duplicate approved Agent origin");
    for (const e of this.endpoints) {
      const u = new URL(e.url);
      this.policies.set(
        e.url,
        new TargetPolicy([
          {
            host: u.hostname.replace(/^\[|\]$/g, ""),
            port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
            addresses: e.addresses,
          },
        ]),
      );
    }
  }
  async destination(url: string) {
    const origin = new URL(HostSchema.shape.url.parse(url)).origin;
    const rule = this.endpoints.find((e) => e.url === origin);
    if (!rule) throw Error("Destination is not permitted by deployment policy");
    const address = await this.policies
      .get(origin)!
      .address(
        CheckSchema.parse({
          id: "agent",
          hostId: "agent",
          name: "Agent",
          type: "http",
          url: origin,
        }),
      );
    const token = rule.tokenEnv ? process.env[rule.tokenEnv] : undefined;
    if (rule.tokenEnv && !token)
      throw Error("Agent authentication is not configured");
    return { address, token };
  }
}
export async function loadAgentTrust(seed: HostConfig[]) {
  const file = process.env.HOSTBOARD_AGENT_POLICY || "private/agents.json";
  if (existsSync(file))
    return new AgentTrust(
      AgentPolicySchema.parse(JSON.parse(readFileSync(file, "utf8"))).endpoints,
    );
  // Compatibility grants come exclusively from the read-only operator bootstrap,
  // never from the editable registry. Legacy DNS origins pin the bootstrap-time
  // answers; an explicit policy should provide durable addresses instead.
  const endpoints = new Map<string, AgentEndpoint>();
  const origins = [
    ...new Map(seed.map((h) => [new URL(h.url).origin, h])).values(),
  ];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, origins.length) }, async () => {
      while (next < origins.length) {
        const h = origins[next++],
          u = new URL(h.url),
          host = u.hostname.replace(/^\[|\]$/g, "");
        const addresses =
          h.addresses ||
          (isIP(host)
            ? [host]
            : await Promise.race([
                lookup(host, { all: true, verbatim: true }).then((a) =>
                  a.map((v) => v.address),
                ),
                new Promise<string[]>((resolve) => {
                  const t = setTimeout(() => resolve([]), 3000);
                  t.unref();
                }),
              ]).catch(() => []));
        if (addresses.length)
          endpoints.set(u.origin, {
            url: u.origin,
            addresses,
            ...(h.tokenEnv ? { tokenEnv: h.tokenEnv } : {}),
          });
      }
    }),
  );
  return new AgentTrust([...endpoints.values()]);
}

// All Agent calls share a bounded pool. Slow destinations cannot create unlimited
// sockets or retain unbounded queued work across dashboard/investigation clients.
let active = 0;
const queue: (() => void)[] = [];
export async function agentSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 12) {
    if (queue.length >= 128) throw Error("Agent request capacity reached");
    await new Promise<void>((resolve) => queue.push(resolve));
  } else active++;
  try {
    return await task();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

let chartsActive = 0;
const chartQueue: (() => void)[] = [];
// Large legacy instance catalogs have a separate admission limit.
export async function chartSlot<T>(task: () => Promise<T>): Promise<T> {
  if (chartsActive >= 2) {
    if (chartQueue.length >= 100) throw Error("Agent request capacity reached");
    await new Promise<void>((resolve) => chartQueue.push(resolve));
  } else chartsActive++;
  try {
    return await task();
  } finally {
    const next = chartQueue.shift();
    if (next) next();
    else chartsActive--;
  }
}
