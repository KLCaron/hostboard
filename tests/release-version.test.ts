// SPDX-License-Identifier: AGPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
test("public setup wrapper and generated environment select this release instead of an obsolete image", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-version-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const args = path.join(dir, "docker-args");
  writeFileSync(
    path.join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_DOCKER_ARGS"\n',
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TEST_DOCKER_ARGS: args,
  };
  delete env.HOSTBOARD_IMAGE;
  assert.equal(
    spawnSync("bash", ["scripts/setup.sh", "--check"], { env }).status,
    0,
  );
  assert(
    readFileSync(args, "utf8")
      .split("\n")
      .includes(`ghcr.io/klcaron/hostboard:${version}`),
  );
  assert.equal(
    spawnSync("bash", ["scripts/setup.sh", "--check"], {
      env: { ...env, HOSTBOARD_IMAGE: "hostboard:custom" },
    }).status,
    0,
  );
  assert(readFileSync(args, "utf8").split("\n").includes("hostboard:custom"));
  const answers = path.join(dir, "answers.json"),
    destination = path.join(dir, "deployment");
  writeFileSync(
    answers,
    JSON.stringify({
      origin: "http://localhost:8088",
      username: "operator",
      password: "controlled password fixture",
      hosts: [
        {
          id: "host",
          name: "Host",
          url: "http://127.0.0.1:19999",
          node: "fixture",
        },
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "server/setup.ts",
      "--directory",
      destination,
      "--answers",
      answers,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert(
    readFileSync(path.join(destination, ".env"), "utf8").includes(
      `HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard:${version}\n`,
    ),
  );
  assert(readFileSync("Dockerfile", "utf8").includes(`ARG VERSION=${version}\n`));
  for (const file of ["compose.yaml", ".env.example"])
    assert(
      readFileSync(file, "utf8").includes(
        `ghcr.io/klcaron/hostboard:${version}`,
      ),
    );
});
