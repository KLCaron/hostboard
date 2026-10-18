import { existsSync, readFileSync } from "node:fs";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
export const AdminSchema = z
  .object({
    issuer: z
      .url()
      .refine((v) => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(v)),
    audience: z.string().min(1),
    emails: z.array(z.email()).min(1),
    origin: z
      .url()
      .refine((v) => new URL(v).origin === v && v.startsWith("https://")),
    targets: z
      .array(
        z
          .object({
            host: z.string().min(1).max(253),
            port: z.number().int().min(1).max(65535),
            addresses: z.array(z.string()).min(1).max(20),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type AdminConfig = z.infer<typeof AdminSchema>;
export function loadAdmin(): AdminConfig | null {
  const file = process.env.HOSTBOARD_ADMIN_CONFIG || "private/admin.json";
  return existsSync(file)
    ? AdminSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : null;
}
export function authorization(
  config: AdminConfig | null,
  keys?: JWTVerifyGetKey,
) {
  const key =
    keys ??
    (config
      ? createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
          timeoutDuration: 5000,
          cooldownDuration: 30000,
        })
      : undefined);
  async function identity(req: Request) {
    if (!config || !key) return null;
    const token = req.get("Cf-Access-Jwt-Assertion");
    if (!token || token.length > 16384) return null;
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "email"],
        maxTokenAge: "24h",
      });
      return typeof payload.email === "string" &&
        config.emails.some(
          (e) => e.toLowerCase() === payload.email!.toString().toLowerCase(),
        )
        ? payload.email
        : null;
    } catch {
      return null;
    }
  }
  const guard: RequestHandler = async (req, res, next) => {
    const email = await identity(req);
    if (!email) {
      res
        .status(403)
        .json({
          error:
            "An authorized Cloudflare Access administrator identity is required",
        });
      return;
    }
    res.locals.actor = email;
    if (
      req.method !== "GET" &&
      (!config ||
        req.get("Origin") !== config.origin ||
        req.get("X-Hostboard-Request") !== "1" ||
        !req.is("application/json"))
    ) {
      res
        .status(403)
        .json({
          error: "A same-origin JSON administrative request is required",
        });
      return;
    }
    next();
  };
  return { guard, identity };
}
