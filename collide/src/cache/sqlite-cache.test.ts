import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getOrCache, getCacheKey, getDb, clearCache, setDbLocation, closeDb } from "./db";
import { extractPackageProfile, PackageProfile } from "../scanners/shared-ast-extractor";
import type { ResolvedPackage } from "../core/types";

describe("Stage 7: AST Profile SQLite Cache Integration", () => {
  let tmpDir: string;
  let dbFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-stage7-test-"));
    dbFilePath = path.join(tmpDir, "cache.sqlite");
    setDbLocation(dbFilePath);
    clearCache();
  });

  afterEach(() => {
    closeDb();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("generates canonical cache keys for standard, scoped, and prerelease packages", () => {
    assert.equal(getCacheKey({ name: "lodash", version: "4.17.21" }), "lodash@4.17.21");
    assert.equal(getCacheKey({ name: "@babel/core", version: "7.20.0" }), "@babel/core@7.20.0");
    assert.equal(
      getCacheKey({ name: "@scope/pkg", version: "1.0.0-alpha.1+build.42" }),
      "@scope/pkg@1.0.0-alpha.1+build.42",
    );
    assert.equal(getCacheKey({ name: "", version: "" }), "unknown@0.0.0");
  });

  it("handles cache miss: parses AST once, writes profile to SQLite, and returns profile", async () => {
    const src = `
window.addEventListener("resize", () => {});
process.on("exit", () => {});
`;
    const sourceFile = path.join(tmpDir, "pkg.js");
    fs.writeFileSync(sourceFile, src, "utf-8");

    const pkg: ResolvedPackage = {
      name: "@my-org/my-pkg",
      version: "1.2.3-rc.1",
      sourcePath: sourceFile,
    };

    let computeCalls = 0;
    const compute = (code: string, pName?: string, sPath?: string) => {
      computeCalls++;
      return extractPackageProfile(code, pName, sPath);
    };

    const profile = await getOrCache(pkg, compute);

    assert.equal(computeCalls, 1);
    assert.equal(profile.listeners.length, 2);

    // Verify row was written to SQLite table
    const db = getDb();
    const row = db.prepare("SELECT profile FROM ast_profiles WHERE key = ?").get("@my-org/my-pkg@1.2.3-rc.1") as { profile: string };
    assert.ok(row);
    const inDb = JSON.parse(row.profile) as PackageProfile;
    assert.deepEqual(inDb, profile);
  });

  it("handles cache hit: restores complete profile from SQLite without invoking AST compute", async () => {
    const src = `
document.addEventListener("DOMContentLoaded", () => {});
const p = require("process");
p.on("SIGTERM", () => {});
`;
    const sourceFile = path.join(tmpDir, "pkg-hit.js");
    fs.writeFileSync(sourceFile, src, "utf-8");

    const pkg: ResolvedPackage = {
      name: "fast-package",
      version: "2.0.0",
      sourcePath: sourceFile,
    };

    let computeCalls = 0;
    const compute = (code: string, pName?: string, sPath?: string) => {
      computeCalls++;
      return extractPackageProfile(code, pName, sPath);
    };

    // First call: Cache miss
    const profile1 = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 1);

    // Second call: Cache hit (compute must NOT be called)
    const profile2 = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 1);

    // Third call: Cache hit
    const profile3 = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 1);

    // All profiles match accurately
    assert.deepEqual(profile2, profile1);
    assert.deepEqual(profile3, profile1);
    assert.equal(profile2.listeners.length, 2);
    assert.deepEqual(profile2.listeners[0].targetIdentity, { type: "document" });
    assert.deepEqual(profile2.listeners[1].targetIdentity, { type: "emitter", name: "process" });
    assert.equal(profile2.listeners[1].receiverScope, "global");
  });

  it("persists and restores profiles across database connections", async () => {
    const src = `window.addEventListener("click", () => {});`;
    const sourceFile = path.join(tmpDir, "persistent.js");
    fs.writeFileSync(sourceFile, src, "utf-8");

    const pkg: ResolvedPackage = {
      name: "persistent-pkg",
      version: "1.0.0",
      sourcePath: sourceFile,
    };

    // Initial run to populate SQLite file
    await getOrCache(pkg, extractPackageProfile);

    // Close SQLite connection and reopen from the same file
    closeDb();
    setDbLocation(dbFilePath);

    let computeCalls = 0;
    const compute = (code: string, pName?: string, sPath?: string) => {
      computeCalls++;
      return extractPackageProfile(code, pName, sPath);
    };

    // Should load from disk SQLite without computing
    const restored = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 0);
    assert.equal(restored.listeners.length, 1);
    assert.deepEqual(restored.listeners[0].targetIdentity, { type: "window" });
    assert.equal(restored.listeners[0].eventName, "click");
  });

  it("isolates entries for different packages sharing the same version and vice versa", async () => {
    const file1 = path.join(tmpDir, "p1.js");
    const file2 = path.join(tmpDir, "p2.js");
    fs.writeFileSync(file1, `window.addEventListener("resize", fn);`, "utf-8");
    fs.writeFileSync(file2, `document.addEventListener("load", fn);`, "utf-8");

    const pkg1: ResolvedPackage = { name: "pkg-alpha", version: "1.0.0", sourcePath: file1 };
    const pkg2: ResolvedPackage = { name: "pkg-beta", version: "1.0.0", sourcePath: file2 };
    const pkg1v2: ResolvedPackage = { name: "pkg-alpha", version: "2.0.0", sourcePath: file1 };

    const prof1 = await getOrCache(pkg1, extractPackageProfile);
    const prof2 = await getOrCache(pkg2, extractPackageProfile);
    const prof1v2 = await getOrCache(pkg1v2, extractPackageProfile);

    assert.equal(prof1.listeners[0].targetIdentity.type, "window");
    assert.equal(prof2.listeners[0].targetIdentity.type, "document");

    const db = getDb();
    const rows = db.prepare("SELECT key FROM ast_profiles").all() as { key: string }[];
    const keys = rows.map((r) => r.key).sort();

    assert.deepEqual(keys, ["pkg-alpha@1.0.0", "pkg-alpha@2.0.0", "pkg-beta@1.0.0"]);
  });

  it("recovers gracefully from corrupted SQLite cached data by recomputing and updating", async () => {
    const src = `window.addEventListener("scroll", fn);`;
    const sourceFile = path.join(tmpDir, "corrupt.js");
    fs.writeFileSync(sourceFile, src, "utf-8");

    const pkg: ResolvedPackage = { name: "corrupt-pkg", version: "1.0.0", sourcePath: sourceFile };

    // Insert invalid corrupted JSON into SQLite manually
    const db = getDb();
    db.prepare("INSERT INTO ast_profiles (key, profile, created_at) VALUES (?, ?, ?)")
      .run("corrupt-pkg@1.0.0", "{ invalid-json :::", Date.now());

    let computeCalls = 0;
    const compute = (code: string, pName?: string, sPath?: string) => {
      computeCalls++;
      return extractPackageProfile(code, pName, sPath);
    };

    // Should detect corrupted JSON, recompute, and overwrite the row
    const profile = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 1);
    assert.equal(profile.listeners.length, 1);
    assert.equal(profile.listeners[0].eventName, "scroll");

    // Subsequent call hits the now-repaired cache
    const secondProfile = await getOrCache(pkg, compute);
    assert.equal(computeCalls, 1);
    assert.deepEqual(secondProfile, profile);
  });
});
