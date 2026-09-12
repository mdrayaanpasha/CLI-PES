// test/profile.test.ts
// Automated tests for the Phase 1 per-package profiling pipeline, run against
// the deterministic synthetic sandbox (see build-sandbox.ts).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildSandbox } from "./build-sandbox";
import { parseLockfile } from "../src/core/lockfile";
import {
  getPackageSourceFiles,
  readSource,
} from "../src/scanners/source-locator";
import { extractPackageProfile } from "../src/scanners/shared-ast-extractor";
import { getOrCache } from "../src/cache/db";
import type { ResolvedPackage } from "../src/core/types";

let SANDBOX_ROOT: string;
let LOCKFILE: string;

before(() => {
  SANDBOX_ROOT = mkdtempSync(join(tmpdir(), "collide-sandbox-"));
  LOCKFILE = buildSandbox(SANDBOX_ROOT);
  // isolate the cache db inside the sandbox so tests never touch the repo
  process.env.COLLIDE_DB_PATH = join(SANDBOX_ROOT, "test-cache.db");
});

after(() => {
  rmSync(SANDBOX_ROOT, { recursive: true, force: true });
});

const byName = (pkgs: ResolvedPackage[], name: string) =>
  pkgs.find((p) => p.name === name);

describe("lockfile parsing", () => {
  test("resolves all non-root packages incl. scoped and nested", () => {
    const pkgs = parseLockfile(LOCKFILE);
    const names = pkgs.map((p) => p.name).sort();
    assert.deepEqual(names, [
      "@scope/thing",
      "alpha",
      "beta",
      "broken",
      "clean-pkg",
      "gamma",
      "nested-dep",
      "no-main",
    ]);
  });

  test("scoped package name derived from last node_modules segment", () => {
    const scoped = byName(parseLockfile(LOCKFILE), "@scope/thing");
    assert.ok(scoped);
    assert.equal(scoped!.version, "4.0.0");
    assert.ok(scoped!.sourcePath?.endsWith("node_modules/@scope/thing"));
  });

  test("nested package resolves to its nested path", () => {
    const nested = byName(parseLockfile(LOCKFILE), "nested-dep");
    assert.ok(nested!.sourcePath?.includes("alpha/node_modules/nested-dep"));
  });
});

describe("source location", () => {
  test("finds the main file for a normal package", () => {
    const alpha = byName(parseLockfile(LOCKFILE), "alpha")!;
    const files = getPackageSourceFiles(alpha);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("index.js"));
    assert.ok(readSource(files).includes("Array.prototype.flat"));
  });

  test("missing main file yields no source, no throw", () => {
    const noMain = byName(parseLockfile(LOCKFILE), "no-main")!;
    assert.deepEqual(getPackageSourceFiles(noMain), []);
  });
});

describe("AST extractor (unit)", () => {
  test("detects prototype assignment and addEventListener", () => {
    const p = extractPackageProfile(`
      Array.prototype.flat = function () {};
      window.addEventListener("resize", () => {});
    `);
    assert.deepEqual(p.writes, ["Array.prototype.flat"]);
    assert.deepEqual(p.listeners, ["window:resize"]);
  });

  test("detects defineProperty on a prototype", () => {
    const p = extractPackageProfile(
      `Object.defineProperty(String.prototype, "pad", { value() {} });`,
    );
    assert.deepEqual(p.writes, ["String.prototype.pad"]);
  });

  test("detects globalThis write and process.on", () => {
    const p = extractPackageProfile(`
      globalThis.__X__ = 1;
      process.on("exit", () => {});
    `);
    assert.deepEqual(p.writes, ["globalThis.__X__"]);
    assert.deepEqual(p.listeners, ["process:exit"]);
  });

  test("ignores ordinary local/module code", () => {
    const p = extractPackageProfile(`
      const obj = {}; obj.x = 1;
      function f() { return 2; }
      emitter.on("data", () => {}); // non-global emitter → ignored
    `);
    assert.deepEqual(p.writes, []);
    assert.deepEqual(p.listeners, []);
  });

  test("de-dupes repeated targets within a package", () => {
    const p = extractPackageProfile(`
      Array.prototype.flat = function () {};
      Array.prototype.flat = function () {};
    `);
    assert.deepEqual(p.writes, ["Array.prototype.flat"]);
  });

  test("unparseable source returns empty profile, never throws", () => {
    const p = extractPackageProfile(`this is <<< not ){ valid @@@`);
    assert.deepEqual(p, { writes: [], listeners: [] });
  });
});

describe("full pipeline via getOrCache", () => {
  async function profileAll() {
    const pkgs = parseLockfile(LOCKFILE);
    const out = new Map<string, { writes: string[]; listeners: string[] }>();
    for (const p of pkgs) {
      out.set(p.name, await getOrCache(p, extractPackageProfile));
    }
    return out;
  }

  test("each sandbox package profiles as expected", async () => {
    const profiles = await profileAll();

    assert.deepEqual(profiles.get("alpha"), {
      writes: ["Array.prototype.flat"],
      listeners: ["window:resize"],
    });
    assert.deepEqual(profiles.get("beta"), {
      writes: ["Array.prototype.flat", "globalThis.__BETA__"],
      listeners: [],
    });
    assert.deepEqual(profiles.get("gamma"), {
      writes: ["String.prototype.pad"],
      listeners: ["process:exit"],
    });
    assert.deepEqual(profiles.get("@scope/thing"), {
      writes: ["window.__SCOPED__"],
      listeners: [],
    });
    assert.deepEqual(profiles.get("nested-dep"), {
      writes: [],
      listeners: ["document:click"],
    });
    // clean / broken / no-main all profile empty and don't crash
    assert.deepEqual(profiles.get("clean-pkg"), { writes: [], listeners: [] });
    assert.deepEqual(profiles.get("broken"), { writes: [], listeners: [] });
    assert.deepEqual(profiles.get("no-main"), { writes: [], listeners: [] });
  });

  test("writes a SQLite cache and serves a warm hit", async () => {
    const dbFile = process.env.COLLIDE_DB_PATH!;
    await profileAll(); // ensure populated
    assert.ok(existsSync(dbFile), "cache db should exist");

    // Warm hit must not re-read source: feed a compute() that would throw if called.
    const alpha = byName(parseLockfile(LOCKFILE), "alpha")!;
    const cached = await getOrCache(alpha, () => {
      throw new Error("compute() called on a cache hit — cache miss bug");
    });
    assert.deepEqual(cached, {
      writes: ["Array.prototype.flat"],
      listeners: ["window:resize"],
    });
  });
});
