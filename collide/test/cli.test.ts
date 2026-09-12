// test/cli.test.ts
// End-to-end test: spawn the real CLI against the sandbox and parse its output.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildSandbox } from "./build-sandbox";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.ts");

let ROOT: string;
let LOCKFILE: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-cli-"));
  LOCKFILE = buildSandbox(ROOT);
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

function runCli(args: string[]): string {
  return execFileSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COLLIDE_DB_PATH: join(ROOT, "cli-cache.db") },
  });
}

describe("collide profile (CLI e2e)", () => {
  test("--format=json emits a valid profile array for every package", () => {
    const out = runCli(["profile", LOCKFILE, "--format=json"]);
    const profiles = JSON.parse(out) as Array<{
      name: string;
      version: string;
      profile: { writes: string[]; listeners: string[] };
    }>;

    assert.equal(profiles.length, 8);
    const alpha = profiles.find((p) => p.name === "alpha")!;
    assert.deepEqual(alpha.profile.writes, ["Array.prototype.flat"]);
    assert.deepEqual(alpha.profile.listeners, ["window:resize"]);

    const gamma = profiles.find((p) => p.name === "gamma")!;
    assert.deepEqual(gamma.profile.writes, ["String.prototype.pad"]);
  });

  test("table format runs and summarizes", () => {
    const out = runCli(["profile", LOCKFILE]);
    assert.match(out, /alpha@1\.0\.0/);
    assert.match(out, /8 packages profiled/); // profile footer summary line
  });

  test("unknown command exits non-zero", () => {
    assert.throws(() => runCli(["bogus", LOCKFILE]));
  });
});
