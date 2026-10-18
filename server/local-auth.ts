import express, { type Express } from "express";
import session from "express-session";
import memorystore from "memorystore";
import { rateLimit } from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { verify } from "argon2";
import { authorization, type LocalConfig } from "./admin.js";
declare module "express-session" {
  interface SessionData { actor?: string; expiresAt?: number; csrf?: string }
}
const TTL = 60 * 60 * 1000;
export function localAuthentication(app: Express, config: LocalConfig) {
  app.set("trust proxy", config.trustedProxies);
  const Store = memorystore(session);
  const store = new Store({ checkPeriod: 60000, max: 1000, ttl: TTL });
  const secure = config.origin.startsWith("https:");
  const name = secure ? "__Host-hostboard" : "hostboard-local";
  app.use(session({
    name, secret: config.sessionSecret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure, sameSite: "strict", maxAge: TTL, path: "/" },
  }));
  app.use("/auth", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const csrf = (req: express.Request) => {
    if (!req.session.csrf) req.session.csrf = randomBytes(32).toString("hex");
    return req.session.csrf;
  };
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Hostboard</title><style>body{background:#101820;color:#e7edf3;font:16px system-ui;margin:8vh auto;padding:24px;max-width:420px}label,input,button{display:block;box-sizing:border-box;width:100%;margin:12px 0}input,button{padding:12px;font:inherit}a{color:#79ccff}</style><h1>Hostboard</h1>${body}</html>`;
  app.get("/auth/login", (req, res) => res.type("html").send(page("Sign in", `<h2>Administrator sign in</h2><form method="post" action="/auth/login"><input type="hidden" name="csrf" value="${csrf(req)}"><label>Username<input name="username" autocomplete="username" required maxlength="80"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button>Sign in</button></form>`)));
  const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: {error: "Too many sign-in attempts. Try again in 15 minutes."} });
  let verifying = false;
  app.post("/auth/login", limit, express.urlencoded({extended: false, limit: "4kb"}), async (req, res, next) => {
    if (req.get("Origin") !== config.origin || !req.session.csrf || req.body?.csrf !== req.session.csrf) {
      res.status(403).send("A same-origin sign-in request is required"); return;
    }
    if (verifying) { res.status(429).send("Sign-in busy. Try again shortly."); return; }
    const {username, password} = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || password.length > 1024) { res.status(400).send("Invalid sign-in request"); return; }
    let valid = false;
    verifying = true;
    try { valid = await verify(config.passwordHash, password); }
    finally { verifying = false; }
    if (!valid || username !== config.username) { res.status(401).type("html").send(page("Sign in failed", '<p>Invalid username or password.</p><a href="/auth/login">Try again</a>')); return; }
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.actor = config.username;
      req.session.expiresAt = Date.now() + TTL;
      req.session.save(error => error ? next(error) : res.redirect(303, "/"));
    });
  });
  app.get("/auth/logout", (req, res) => res.type("html").send(page("Sign out", `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${csrf(req)}"><button>Sign out</button></form>`)));
  app.post("/auth/logout", express.urlencoded({extended: false, limit: "4kb"}), (req, res, next) => {
    if (req.get("Origin") !== config.origin || !req.session.csrf || req.body?.csrf !== req.session.csrf) { res.sendStatus(403); return; }
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie(name, {path: "/", secure, httpOnly: true, sameSite: "strict"}).redirect(303, "/auth/login");
    });
  });
  const auth = authorization(config);
  app.use(async (req, res, next) => {
    if (await auth.identity(req)) return next();
    if (req.path.startsWith("/api/")) { res.status(401).json({error: "Sign in at /auth/login"}); return; }
    res.redirect(303, "/auth/login");
  });
  return () => store.stopInterval();
}
