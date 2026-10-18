import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
const targets = z.array(z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  addresses: z.array(z.string().refine(v => !!isIP(v), "Use literal IP addresses")).min(1).max(20),
}).strict()).max(200);
const origin = z.url().refine(v => {
  const u = new URL(v);
  return u.origin === v && !u.username && !u.password &&
    (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
}, "Use an HTTPS origin, or HTTP on localhost for an SSH tunnel");
const CloudflareSchema = z.object({
  mode: z.literal("cloudflare").optional(),
  issuer: z.url().refine(v => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(v)),
  audience: z.string().min(1),
  emails: z.array(z.email()).min(1),
  origin: z.url().refine(v => new URL(v).origin === v && v.startsWith("https://")),
  targets,
}).strict();
export const LocalSchema = z.object({
  mode: z.literal("local"), origin,
  username: z.string().regex(/^[a-zA-Z0-9_.@-]{1,80}$/),
  passwordHash: z.string().regex(/^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/),
  sessionSecret: z.string().regex(/^[a-f0-9]{64}$/),
  // Exact proxy IPs only. Never trust forwarding headers from arbitrary clients.
  trustedProxies: z.array(z.string().refine(v => !!isIP(v))).max(20).default([]),
  targets,
}).strict();
export const AdminSchema = z.union([CloudflareSchema, LocalSchema]);
export type AdminConfig = z.infer<typeof AdminSchema>;
export type LocalConfig = z.infer<typeof LocalSchema>;
export function loadAdmin(): AdminConfig | null {
  const file = process.env.HOSTBOARD_ADMIN_CONFIG || "private/admin.json";
  return existsSync(file) ? AdminSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : null;
}
export function authorization(config: AdminConfig | null, keys?: JWTVerifyGetKey) {
  const cloudflare = config && config.mode !== "local" ? config : null;
  const key = keys ?? (cloudflare ? createRemoteJWKSet(new URL(`${cloudflare.issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5000, cooldownDuration: 30000,
  }) : undefined);
  async function identity(req: Request) {
    if (config?.mode === "local") {
      return req.session?.actor === config.username && (req.session.expiresAt ?? 0) > Date.now()
        ? config.username : null;
    }
    if (!cloudflare || !key) return null;
    const token = req.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16384) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: cloudflare.issuer, audience: cloudflare.audience, algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "email"], maxTokenAge: "24h",
      });
      return typeof payload.email === "string" && cloudflare.emails.some(e => e.toLowerCase() === payload.email!.toString().toLowerCase()) ? payload.email : null;
    } catch { return null; }
  }
  const guard: RequestHandler = async (req, res, next) => {
    const actor = await identity(req);
    if (!actor) { res.status(403).json({error: "An authorized administrator identity is required"}); return; }
    res.locals.actor = actor;
    if (req.method !== "GET" && (!config || req.get("Origin") !== config.origin ||
        req.get("X-Hostboard-Request") !== "1" || !req.is("application/json"))) {
      res.status(403).json({error: "A same-origin JSON administrative request is required"}); return;
    }
    next();
  };
  return { guard, identity };
}
