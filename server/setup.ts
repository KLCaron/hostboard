import release from "../package.json" with { type: "json" };
import { input, password, confirm, select } from "@inquirer/prompts";
import { hash, argon2id } from "argon2";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, chownSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AgentPolicySchema } from "./agent-policy.js";
import { AdminSchema } from "./admin.js";
import { ConfigSchema } from "./config.js";
import { ChecksSchema } from "./check-config.js";
import { SmtpSchema } from "./notifications.js";
const {values} = parseArgs({options: {directory: {type: "string", default: process.cwd()}, answers: {type: "string"}, check: {type: "boolean"}}});
const dir = path.resolve(values.directory!);
const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const safePath = z.string().regex(/^(\.\/|\/)[a-zA-Z0-9_./-]+$/, "Use ./relative/path or an absolute path without spaces or shell syntax");
async function main() {
  process.umask(0o077);
  if (values.check) {
    const hosts = ConfigSchema.parse(read("config/hosts.json")).hosts;
    AdminSchema.parse(read("private/admin.json"));
    if (existsSync(path.join(dir, "private/agents.json"))) AgentPolicySchema.parse(read("private/agents.json"));
    const checks = ChecksSchema.parse(existsSync(path.join(dir, "config/checks.json")) ? read("config/checks.json") : {});
    if (checks.checks.some(c => !hosts.some(h => h.id === c.hostId))) throw Error("A check refers to an unknown host");
    if (existsSync(path.join(dir, "private/smtp.json"))) SmtpSchema.parse(read("private/smtp.json"));
    console.log("Configuration is valid. Agent reachability is checked by the dashboard; unavailable Agents do not block startup.");
    return;
  }
  for (const f of [".env", "config/hosts.json", "private/admin.json", "config/checks.json", "private/smtp.json"])
    if (existsSync(path.join(dir, f))) throw Error(`Existing ${f} preserved. Use --check to validate; edit existing configuration explicitly.`);
  let a: Record<string, any>;
  if (values.answers) a = JSON.parse(readFileSync(values.answers, "utf8"));
  else {
    console.log("Hostboard setup. No public setup server will be opened. HTTPS is required for remote local login; localhost works over an SSH tunnel.");
    a = {};
    a.port = Number(await input({message: "Listening port on the Docker host", default: "8088"}));
    a.origin = await input({message: "Browser URL (origin, no trailing slash)", default: `http://localhost:${a.port}`});
    a.bind = await input({message: "Host interface to publish", default: "127.0.0.1"});
    a.dataDir = await input({message: "Persistent data directory", default: "./data"});
    a.hosts = [];
    do {
      a.hosts.push({id: await input({message: "Unique server ID", default: `server-${a.hosts.length + 1}`}),
        name: await input({message: "Display name", default: `Server ${a.hosts.length + 1}`}),
        url: await input({message: "Agent origin reachable FROM THE CONTAINER (not Netdata Cloud)", default: "http://host.docker.internal:19999"}),
        node: await input({message: "Exact Agent node hostname, machine GUID, or node UUID"})});
    } while (await confirm({message: "Add another Agent?", default: false}));
    a.mode = await select({message: "Administrator authentication", choices: [{value:"local", name:"Local administrator"}, {value:"cloudflare", name:"Existing Cloudflare Access application"}]});
    if (a.mode === "local") {
      a.username = await input({message: "Administrator username", default: "admin"});
      a.password = await password({message: "New password (at least 16 characters)", mask: "*"});
      const repeated = await password({message: "Repeat password", mask: "*"});
      if (a.password !== repeated) throw Error("Passwords did not match; no files written");
    } else {
      a.issuer = await input({message: "Access team issuer (https://TEAM.cloudflareaccess.com)"});
      a.audience = await input({message: "Access application audience"});
      a.emails = [await input({message: "Allowed administrator email"})];
    }
    if (await confirm({message: "Configure optional SMTP notifications now?", default: false})) {
      a.smtp = {host: await input({message:"SMTP host"}), port: Number(await input({message:"SMTP port",default:"587"})),
        username: await input({message:"SMTP username (email)"}), password: await password({message:"SMTP password",mask:"*"}),
        from: await input({message:"Sender email"}), to: [await input({message:"Recipient email"})]};
    }
    console.log("Optional service checks can be added after sign-in in Settings → Services. Approve exact host, port and IP addresses in private/admin.json first (see docs/service-checks.md).");
  }
  const hosts = ConfigSchema.parse({hosts: a.hosts});
  const port = z.number().int().min(1024).max(65535).parse(a.port ?? 8088);
  const bind = z.ipv4().parse(a.bind ?? "127.0.0.1");
  const dataDir = safePath.parse(a.dataDir ?? "./data");
  const checks = ChecksSchema.parse(a.checks ?? {});
  if (checks.checks.some(c => !hosts.hosts.some(h => h.id === c.hostId))) throw Error("A check refers to an unknown host");
  const common = {origin: a.origin, targets: a.targets ?? []};
  const admin = AdminSchema.parse(a.mode === "cloudflare" ? {...common, mode: "cloudflare", issuer: a.issuer, audience: a.audience, emails: a.emails} : {
    ...common, mode: "local", username: a.username,
    passwordHash: await hash(z.string().min(16).max(1024).parse(a.password), {type: argon2id, memoryCost:65536,timeCost:3,parallelism:1}),
    sessionSecret: randomBytes(32).toString("hex"), trustedProxies: a.trustedProxies ?? [],
  });
  const smtp = a.smtp ? SmtpSchema.parse(a.smtp) : null;
  // Validate everything before creating any configuration. Never overwrite existing files.
  for (const d of ["config", "private", dataDir]) mkdirSync(path.resolve(dir, d), {recursive:true, mode:0o700});
  const write = (file: string, value: unknown) => writeFileSync(path.join(dir,file), JSON.stringify(value,null,2)+"\n", {mode:0o600,flag:"wx"});
  write("config/hosts.json", hosts); write("config/checks.json",checks); write("private/admin.json", admin);
  if (smtp) write("private/smtp.json",smtp);
  writeFileSync(path.join(dir,".env"), `HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard:${release.version}\nHOSTBOARD_UID=${process.getuid?.() || 1000}\nHOSTBOARD_GID=${process.getgid?.() || 1000}\nHOSTBOARD_BIND=${bind}\nHOSTBOARD_PORT=${port}\nHOSTBOARD_PUBLIC_URL=${admin.origin}\nHOSTBOARD_DATA_DIR=${dataDir}\nHOSTBOARD_PRIVATE_DIR=./private\n`, {mode:0o600,flag:"wx"});
  // node in the image is uid 1000. Other operators can grant this uid access explicitly.
  chmodSync(path.join(dir,"private"),0o700);
  if (process.getuid?.() === 0) {
    for (const f of ["config", "private", dataDir, "config/hosts.json", "config/checks.json", "private/admin.json", ...(smtp ? ["private/smtp.json"] : [])]) chownSync(path.resolve(dir,f),1000,1000);
  }
  console.log("Configuration created. Run scripts/setup.sh --check, then docker compose up -d. Container uid 1000 needs config/private read access and data write access. See docs/installation.md for other host UIDs.");
  console.log("Networking: Agents must accept connections from the Docker bridge or a private routable network. host.docker.internal cannot reach an Agent bound only to host loopback. Never expose Agent ports to the Internet.");
}
main().catch(e => {
  // Never print Zod input values, passwords or hashes.
  console.error(e instanceof z.ZodError ? "Invalid configuration: " + e.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof SyntaxError ? "Invalid JSON configuration" : e.message);
  process.exitCode = 1;
});
