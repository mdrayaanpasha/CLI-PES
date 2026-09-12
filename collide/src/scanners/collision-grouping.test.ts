import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupListenerCollisions, eventListenerScanner } from "./event-listeners";
import { extractPackageProfile, PackageProfile } from "./shared-ast-extractor";
import type { ResolvedPackage } from "../core/types";

describe("Stage 9: Cross-Package Listener Collision Grouping", () => {
  it("detects a collision when 2 distinct packages share the same canonical target", () => {
    const codeA = `process.on("uncaughtException", () => {});`;
    const codeB = `process.addListener("uncaughtException", () => {});`;

    const pkgs: ResolvedPackage[] = [
      { name: "pkg-a", version: "1.0.0", sourcePath: "/path/to/pkg-a/index.js" },
      { name: "pkg-b", version: "2.1.0", sourcePath: "/path/to/pkg-b/index.js" },
    ];

    const profiles: PackageProfile[] = [
      extractPackageProfile(codeA, "pkg-a", "/path/to/pkg-a/index.js"),
      extractPackageProfile(codeB, "pkg-b", "/path/to/pkg-b/index.js"),
    ];

    const collisions = groupListenerCollisions(pkgs, profiles);

    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].canonicalTarget, "global_process:uncaughtException");
    assert.deepEqual(collisions[0].owners, ["pkg-a", "pkg-b"]);

    // Validate participant metadata preservation
    assert.equal(collisions[0].participants.length, 2);
    assert.deepEqual(collisions[0].participants[0], {
      packageName: "pkg-a",
      packageVersion: "1.0.0",
      canonicalTarget: "global_process:uncaughtException",
      listenerMethod: "on",
      eventName: "uncaughtException",
      sourceLocation: { line: 1, column: 0 },
      moduleContext: "/path/to/pkg-a/index.js",
    });
    assert.deepEqual(collisions[0].participants[1], {
      packageName: "pkg-b",
      packageVersion: "2.1.0",
      canonicalTarget: "global_process:uncaughtException",
      listenerMethod: "addListener",
      eventName: "uncaughtException",
      sourceLocation: { line: 1, column: 0 },
      moduleContext: "/path/to/pkg-b/index.js",
    });
  });

  it("groups 3+ packages sharing the same target into a single collision group", () => {
    const code1 = `window.addEventListener("resize", () => {});`;
    const code2 = `globalThis.window.addEventListener('resize', () => {});`;
    const code3 = `const win = window; win.addEventListener("resize", () => {});`;

    const pkgs: ResolvedPackage[] = [
      { name: "pkg-one", version: "1.0.0" },
      { name: "pkg-two", version: "1.1.0" },
      { name: "pkg-three", version: "1.2.0" },
    ];

    const profiles: PackageProfile[] = [
      extractPackageProfile(code1, "pkg-one", "one.js"),
      extractPackageProfile(code2, "pkg-two", "two.js"),
      extractPackageProfile(code3, "pkg-three", "three.js"),
    ];

    const collisions = groupListenerCollisions(pkgs, profiles);

    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].canonicalTarget, "global_window:resize");
    assert.deepEqual(collisions[0].owners, ["pkg-one", "pkg-three", "pkg-two"]);
    assert.equal(collisions[0].participants.length, 3);
  });

  it("does NOT flag collisions when multiple registrations come from the same package", () => {
    const code = `
process.on("exit", () => {});
process.on("exit", () => {});
process.addListener("exit", () => {});
process.once("exit", () => {});
`;
    const pkgs: ResolvedPackage[] = [{ name: "solo-pkg", version: "1.0.0" }];
    const profiles: PackageProfile[] = [extractPackageProfile(code, "solo-pkg", "index.js")];

    const collisions = groupListenerCollisions(pkgs, profiles);

    // Single owner registering multiple times must NOT be considered a cross-package collision
    assert.equal(collisions.length, 0);
  });

  it("creates separate collision groups for different canonical targets", () => {
    const codeA = `
process.on("exit", fn);
window.addEventListener("resize", fn);
`;
    const codeB = `
process.on("exit", fn);
window.addEventListener("resize", fn);
`;

    const pkgs: ResolvedPackage[] = [
      { name: "pkg-a", version: "1.0.0" },
      { name: "pkg-b", version: "2.0.0" },
    ];

    const profiles: PackageProfile[] = [
      extractPackageProfile(codeA, "pkg-a", "a.js"),
      extractPackageProfile(codeB, "pkg-b", "b.js"),
    ];

    const collisions = groupListenerCollisions(pkgs, profiles);

    assert.equal(collisions.length, 2);
    const targets = collisions.map((c) => c.canonicalTarget).sort();
    assert.deepEqual(targets, ["global_process:exit", "global_window:resize"]);
  });

  it("filters out local emitters and avoids false collisions across packages", () => {
    const codeA = `
const server = createServer();
server.on("request", fn);
`;
    const codeB = `
const server = createServer();
server.on("request", fn);
`;
    const codeC = `
process.on("request", fn);
`;

    const pkgs: ResolvedPackage[] = [
      { name: "server-a", version: "1.0.0" },
      { name: "server-b", version: "1.0.0" },
      { name: "proc-pkg", version: "1.0.0" },
    ];

    const profiles: PackageProfile[] = [
      extractPackageProfile(codeA, "server-a", "a.js"),
      extractPackageProfile(codeB, "server-b", "b.js"),
      extractPackageProfile(codeC, "proc-pkg", "c.js"),
    ];

    const collisions = groupListenerCollisions(pkgs, profiles);

    // Local emitters server-a and server-b are filtered out as non-globals,
    // and proc-pkg is a single package on global_process:request -> 0 collisions
    assert.equal(collisions.length, 0);
  });
});
