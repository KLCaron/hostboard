// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { SSHLogProvider } from "../server/logs.js";
const root = mkdtempSync(path.join(tmpdir(), "hb-log-ssh-")),
  suffix = Date.now(),
  name = `hb-log-ssh-${suffix}`,
  fixture = `hb-log-output-${suffix}`;
const docker = (...args: string[]) =>
  execFileSync(
    process.env.DOCKER === "sudo" ? "sudo" : "docker",
    process.env.DOCKER === "sudo" ? ["-n", "docker", ...args] : args,
    { encoding: "utf8" },
  ).trim();
const ssh = (command: string, input: string) =>
  spawnSync(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${root}/known_hosts`,
      "-i",
      `${root}/id_ed25519`,
      "-p",
      String(port),
      `hostboard-logs@127.0.0.1`,
      command,
    ],
    { input, encoding: "utf8", timeout: 12000 },
  );
let port = 0;
try {
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    `${root}/id_ed25519`,
  ]);
  writeFileSync(
    `${root}/authorized_keys`,
    `restrict,command="/usr/local/libexec/hostboard-logs" ${readFileSync(`${root}/id_ed25519.pub`, "utf8")}`,
    { mode: 0o644 },
  );
  writeFileSync(
    `${root}/config.json`,
    JSON.stringify({
      sources: [
        {
          id: "fixture",
          name: "Controlled fixture",
          labels: { "hostboard.fixture": fixture },
        },
      ],
    }),
    { mode: 0o644 },
  );
  docker(
    "build",
    "-q",
    "-f",
    "tests/fixtures/log-sshd.Dockerfile",
    "-t",
    "hostboard:log-sshd-test",
    ".",
  );
  const cid = docker(
    "run",
    "-d",
    "--name",
    fixture,
    "--label",
    `hostboard.fixture=${fixture}`,
    "node:24-alpine",
    "node",
    "-e",
    `console.log('fixture stdout');console.error('fixture stderr');setInterval(()=>console.log('fixture follow'),500)`,
  );
  docker(
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::2222",
    "--mount",
    "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount",
    `type=bind,src=${root}/authorized_keys,dst=/run/auth-input,readonly`,
    "--mount",
    `type=bind,src=${root}/config.json,dst=/etc/hostboard-logs.json,readonly`,
    "hostboard:log-sshd-test",
  );
  port = Number(docker("port", name, "2222/tcp").split(":").pop());
  await new Promise((r) => setTimeout(r, 1200));
  const key = docker("exec", name, "cat", "/etc/ssh/ssh_host_ed25519_key.pub");
  writeFileSync(`${root}/known_hosts`, `[127.0.0.1]:${port} ${key}\n`);
  const provider = new SSHLogProvider(
      { hosts: [{ hostId: "fixture", address: "127.0.0.1", port }] },
      root,
    ),
    signal = new AbortController().signal;
  const catalog = await provider.sources("fixture", signal).catch((e) => {
    console.error(ssh("hostboard-logs-v1", JSON.stringify({ op: "sources" })));
    console.error(docker("logs", name));
    throw e;
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].containerId, cid);
  const query = {
    source: "fixture",
    after: new Date(Date.now() - 60000).toISOString(),
    before: new Date().toISOString(),
  };
  const result = await provider.query("fixture", query, signal);
  assert(
    result.entries.some(
      (e) => e.stream === "stdout" && e.text === "fixture stdout",
    ),
  );
  assert(
    result.entries.some(
      (e) => e.stream === "stderr" && e.text === "fixture stderr",
    ),
  );
  for (const command of [
    "sh",
    "docker ps",
    "hostboard-logs-v1; id",
    "cat /etc/passwd",
  ]) {
    const r = ssh(command, "{}");
    assert.notEqual(r.status, 0);
    assert(!r.stdout.includes("root:"));
  }
  for (const q of [
    { op: "exec", cmd: "id" },
    { op: "query", source: "other", after: query.after, before: query.before },
    { op: "sources", path: "/containers/json" },
    {
      op: "query",
      source: "fixture",
      after: query.after,
      before: query.before,
      method: "DELETE",
    },
  ]) {
    const r = ssh("hostboard-logs-v1", JSON.stringify(q));
    assert.notEqual(r.status, 0);
    assert(JSON.parse(r.stdout).error);
  }
  const oversized = ssh("hostboard-logs-v1", "x".repeat(5000));
  assert.notEqual(oversized.status, 0);
  // Hold three inputs open after admission; a fourth cannot reach Docker.
  const holders = Array.from({ length: 3 }, () =>
    spawn(
      "ssh",
      [
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${root}/known_hosts`,
        "-i",
        `${root}/id_ed25519`,
        "-p",
        String(port),
        "hostboard-logs@127.0.0.1",
        "hostboard-logs-v1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  try {
    await new Promise((r) => setTimeout(r, 800));
    const busy = ssh("hostboard-logs-v1", JSON.stringify({ op: "sources" }));
    assert.notEqual(busy.status, 0);
    assert.match(JSON.parse(busy.stdout).error, /busy/);
  } finally {
    await Promise.all(
      holders.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on("close", () => resolve());
            child.stdin.end(JSON.stringify({ op: "sources" }));
          }),
      ),
    );
  }
  writeFileSync(`${root}/known_hosts`, "");
  await assert.rejects(provider.sources("fixture", signal), /unavailable/);
  assert.equal(docker("inspect", "-f", "{{.State.Running}}", fixture), "true");
  console.log(
    "Real forced-command SSH acceptance passed: pinned host key, dedicated key, approved source, stdout/stderr, arbitrary command/API/oversized-query denials, wrong host-key denial; fixture unchanged",
  );
} finally {
  for (const n of [name, fixture]) {
    try {
      docker("rm", "-f", n);
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
}
