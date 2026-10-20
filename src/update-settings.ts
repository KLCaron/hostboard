// SPDX-License-Identifier: AGPL-3.0-only
/** Exact DNS hostname, optionally with a port. No URLs, credentials or wildcards. */
export function validRegistry(value: string): boolean {
  if (value.length > 259 || value !== value.toLowerCase()) return false;
  const match = /^([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(value);
  if (!match || (match[2] && Number(match[2]) > 65535)) return false;
  const host = match[1];
  return (
    host.length <= 253 &&
    host.includes(".") &&
    !/^[0-9.]+$/.test(host) &&
    host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}
export function imageRegistry(image: string): string {
  const first = image.split("/")[0];
  const host =
    image.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost")
      ? first
      : "registry-1.docker.io";
  return ["docker.io", "index.docker.io"].includes(host)
    ? "registry-1.docker.io"
    : host;
}
export const approvalMissing = (service: { state: string; message: string }) =>
  service.state === "unavailable" &&
  service.message === "Registry is not approved in collector configuration";
export interface UpdatePreferences {
  intervalSeconds: number;
  staleSeconds: number;
  hosts: Record<string, { enabled: boolean; proposedRegistries: string[] }>;
}
export interface UpdateSettingsView {
  revision: number;
  preferences: UpdatePreferences;
  hosts: {
    hostId: string;
    name: string;
    configured: boolean;
    paused: boolean;
    reader: { address: string; port: number; nodeGuid: string } | null;
    collectedAt: number | null;
    receivedAt: number | null;
    error: string | null;
    packageState: string;
    dockerState: string;
    policy: {
      approvedRegistries: string[];
      packageStaleSeconds: number;
    } | null;
    policyStale: boolean;
    missing: {
      registry: string;
      project: string;
      service: string;
      image: string;
    }[];
  }[];
}
