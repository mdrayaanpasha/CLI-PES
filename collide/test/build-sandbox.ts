// test/build-sandbox.ts
// Builds a deterministic synthetic install tree (node_modules + package-lock.json)
// with packages whose global/prototype/listener patterns we control exactly,
// so the profiler's output is fully predictable in tests.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SandboxPackage {
  /** lockfile key relative to root, e.g. "node_modules/alpha" */
  key: string;
  name: string;
  version: string;
  /** contents of the package's main file */
  source: string;
  /** package.json "main" (default "index.js") */
  main?: string;
  /** if set, write source here instead of at <main>; used to break resolution */
  writeSourceTo?: string | null;
}

// ── The sandbox catalogue — every expectation in the tests maps to one of these ──
export const SANDBOX_PACKAGES: SandboxPackage[] = [
  {
    key: "node_modules/alpha",
    name: "alpha",
    version: "1.0.0",
    // prototype write + a listener
    source: `
      Array.prototype.flat = function () { return this; };
      window.addEventListener("resize", () => {});
    `,
  },
  {
    key: "node_modules/beta",
    name: "beta",
    version: "2.1.0",
    // same prototype target as alpha (Phase-2 collision fuel) + global write
    source: `
      Array.prototype.flat = function () {};
      globalThis.__BETA__ = true;
    `,
  },
  {
    key: "node_modules/gamma",
    name: "gamma",
    version: "0.3.0",
    // defineProperty on a prototype + a process listener
    source: `
      Object.defineProperty(String.prototype, "pad", { value() {} });
      process.on("exit", () => {});
    `,
  },
  {
    key: "node_modules/clean-pkg",
    name: "clean-pkg",
    version: "1.2.3",
    // nothing interesting — must profile as empty
    source: `
      function add(a, b) { return a + b; }
      module.exports = { add };
    `,
  },
  {
    key: "node_modules/@scope/thing",
    name: "@scope/thing",
    version: "4.0.0",
    // scoped package + global assignment
    source: `window.__SCOPED__ = 1;`,
  },
  {
    key: "node_modules/alpha/node_modules/nested-dep",
    name: "nested-dep",
    version: "9.9.9",
    // nested (deduped-conflict) install; listener only
    source: `document.addEventListener("click", () => {});`,
  },
  {
    key: "node_modules/broken",
    name: "broken",
    version: "1.0.0",
    // unparseable — must NOT crash, must profile empty
    source: `this is <<< not ){ valid javascript @@@ 123`,
  },
  {
    key: "node_modules/no-main",
    name: "no-main",
    version: "1.0.0",
    main: "missing.js", // points at a file we never write
    source: "",
    writeSourceTo: null,
  },
];

/**
 * Materialize the sandbox into `root`. Returns the path to package-lock.json.
 * Idempotent: wipes `root` first.
 */
export function buildSandbox(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const packagesMap: Record<string, { version: string }> = {
    "": { version: "1.0.0" }, // root project entry
  };

  for (const pkg of SANDBOX_PACKAGES) {
    const pkgDir = join(root, pkg.key);
    mkdirSync(pkgDir, { recursive: true });
    const main = pkg.main ?? "index.js";

    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, main }, null, 2),
    );

    // write source at its main unless deliberately suppressed
    if (pkg.writeSourceTo !== null) {
      writeFileSync(join(pkgDir, pkg.writeSourceTo ?? main), pkg.source);
    }

    packagesMap[pkg.key] = { version: pkg.version };
  }

  const lockfile = {
    name: "sandbox-root",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: packagesMap,
  };

  const lockPath = join(root, "package-lock.json");
  writeFileSync(lockPath, JSON.stringify(lockfile, null, 2));
  return lockPath;
}

// Allow running standalone: `tsx test/build-sandbox.ts <dir>` to inspect it.
if (process.argv[1] && process.argv[1].endsWith("build-sandbox.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".sandbox");
  const p = buildSandbox(dir);
  console.log("sandbox built at", dir);
  console.log("lockfile:", p);
}
