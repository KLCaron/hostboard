import { lookup } from "node:dns/promises";
import net from "node:net";
import type { CheckConfig } from "./check-config.js";
import type { AdminConfig } from "./admin.js";
export type TargetRule = AdminConfig["targets"][number];
export function endpoint(c: CheckConfig) {
  const u = c.type === "http" ? new URL(c.url) : null;
  return {
    host: u
      ? u.hostname.replace(/^\[|\]$/g, "")
      : c.type === "tcp"
        ? c.address
        : "",
    port: u
      ? Number(u.port || (u.protocol === "https:" ? 443 : 80))
      : c.type === "tcp"
        ? c.port
        : 0,
  };
}
function blocked(ip: string) {
  // IPv4-mapped IPv6 is deliberately unsupported, avoiding alternate-address bypasses.
  if (!net.isIP(ip) || ip.includes("%") || ip.toLowerCase().includes("ffff:"))
    return true;
  const list = new net.BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["169.254.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    list.addSubnet(address, prefix);
  list.addAddress("::", "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  list.addAddress("fd00:ec2::254", "ipv6");
  return list.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");
}
function sameIP(a: string, b: string) {
  if (net.isIP(a) !== net.isIP(b) || !net.isIP(a)) return false;
  const list = new net.BlockList();
  list.addAddress(a, net.isIP(a) === 6 ? "ipv6" : "ipv4");
  return list.check(b, net.isIP(b) === 6 ? "ipv6" : "ipv4");
}
export class TargetPolicy {
  constructor(
    readonly rules: TargetRule[],
    private readonly resolve = lookup,
  ) {}
  async address(check: CheckConfig, timeoutMs = 3000) {
    const { host, port } = endpoint(check);
    const rules = this.rules.filter(
      (r) => r.host.toLowerCase() === host.toLowerCase() && r.port === port,
    );
    if (!rules.length)
      throw Error("Destination is not permitted by deployment policy");
    const answers = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await Promise.race([
          this.resolve(host, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () => reject(Error("DNS resolution timed out")),
              Math.max(1, Math.min(3000, timeoutMs)),
            );
            t.unref();
          }),
        ]);
    if (
      !answers.length ||
      answers.some(
        (a) =>
          blocked(a.address) ||
          !rules.some((r) => r.addresses.some((ip) => sameIP(ip, a.address))),
      )
    )
      throw Error("Destination address is not permitted by deployment policy");
    return answers[0];
  }
  async validate(check: CheckConfig) {
    await this.address(check);
    if (check.type === "http" && new URL(check.url).search)
      throw Error("Monitoring URLs must not contain query strings");
  }
}
