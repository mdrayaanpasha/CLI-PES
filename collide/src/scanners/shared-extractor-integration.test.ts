import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { extractPackageProfile, PackageProfile } from "./shared-ast-extractor";
import { globalStateScanner } from "./global-state";
import { eventListenerScanner } from "./event-listeners";
import { getOrCache, clearCache } from "../cache/db";
import type { ResolvedPackage } from "../core/types";

describe("Stage 6: Shared AST Extractor Integration and Caching", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-stage6-test-"));
  });

  it("extracts both writes and listeners in a single AST walk", () => {
    const code = `
window.addEventListener("resize", onResize);
process.on("exit", onExit);
`;
    const profile: PackageProfile = extractPackageProfile(code, "test-pkg", "index.js");

    assert.ok(Array.isArray(profile.writes));
    assert.ok(Array.isArray(profile.listeners));
    assert.equal(profile.listeners.length, 2);
    assert.equal(profile.listeners[0].targetIdentity.type, "window");
    assert.equal(profile.listeners[1].targetIdentity.name, "process");
  });

  it("reuses cached profile for repeated requests across scanners without duplicate AST work", async () => {
    const pkgSource = `
window.addEventListener("resize", () => {});
process.on("exit", () => {});
`;
    const sourceFile = path.join(tmpDir, "index.js");
    fs.writeFileSync(sourceFile, pkgSource, "utf-8");

    const pkg: ResolvedPackage = {
      name: "pkg-a",
      version: "1.0.0",
      sourcePath: sourceFile,
    };

    let computeCount = 0;
    const trackedCompute = (code: string, pkgContext?: string, modContext?: string) => {
      computeCount++;
      return extractPackageProfile(code, pkgContext, modContext);
    };

    // First call (e.g. from Scanner 2)
    const profile1 = await getOrCache(pkg, trackedCompute);
    assert.equal(computeCount, 1);
    assert.equal(profile1.listeners.length, 2);

    // Second call (e.g. from Scanner 3 for the same package)
    const profile2 = await getOrCache(pkg, trackedCompute);
    assert.equal(computeCount, 1); // Not called again!
    assert.strictEqual(profile1, profile2); // Exact same cached instance
  });

  it("allows Scanner 2 and Scanner 3 to run concurrently on shared cached profiles", async () => {
    const src1 = `
window.addEventListener("resize", () => {});
process.on("exit", () => {});
`;
    const src2 = `
window.addEventListener("resize", () => {});
process.on("exit", () => {});
`;

    const file1 = path.join(tmpDir, "pkg1.js");
    const file2 = path.join(tmpDir, "pkg2.js");
    fs.writeFileSync(file1, src1, "utf-8");
    fs.writeFileSync(file2, src2, "utf-8");

    const pkgs: ResolvedPackage[] = [
      { name: "pkg-1", version: "1.0.0", sourcePath: file1 },
      { name: "pkg-2", version: "1.0.0", sourcePath: file2 },
    ];

    // Run Scanner 2 and Scanner 3 concurrently
    const [globalFindings, listenerFindings] = await Promise.all([
      globalStateScanner.scan(pkgs),
      eventListenerScanner.scan(pkgs),
    ]);

    // Scanner 2: global-state findings
    assert.ok(Array.isArray(globalFindings));

    // Scanner 3: event-listeners findings should detect collisions on window:resize and emitter:process:exit
    assert.equal(listenerFindings.length, 2);

    const targets = listenerFindings.map((f) => f.target).sort();
    assert.deepEqual(targets, ["emitter:process:exit", "window:resize"]);

    for (const finding of listenerFindings) {
      assert.equal(finding.scanner, "event-listeners");
      assert.equal(finding.severity, "medium");
      assert.deepEqual(finding.owners.sort(), ["pkg-1", "pkg-2"]);
    }
  });

  it("preserves individual package profile isolation in cache", async () => {
    const fileA = path.join(tmpDir, "a.js");
    const fileB = path.join(tmpDir, "b.js");
    fs.writeFileSync(fileA, `window.addEventListener("click", fn);`, "utf-8");
    fs.writeFileSync(fileB, `document.addEventListener("load", fn);`, "utf-8");

    const pkgA: ResolvedPackage = { name: "pkg-a", version: "1.0.0", sourcePath: fileA };
    const pkgB: ResolvedPackage = { name: "pkg-b", version: "2.0.0", sourcePath: fileB };

    const profA = await getOrCache(pkgA, extractPackageProfile);
    const profB = await getOrCache(pkgB, extractPackageProfile);

    assert.notStrictEqual(profA, profB);
    assert.equal(profA.listeners[0].targetIdentity.type, "window");
    assert.equal(profB.listeners[0].targetIdentity.type, "document");
  });
});
