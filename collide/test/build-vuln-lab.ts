// test/build-vuln-lab.ts
// Builds a "vuln lab" project engineered to trip ALL FOUR scanners at once:
//
//   • osv              — real package names at known-vulnerable versions
//   • version-conflict — lodash(x3), react(x4), express(x2), axios(x3),
//                        chalk(x2), moment(x2) at differing versions
//   • global-state     — Array.prototype.flat/at, String.prototype.trimStart,
//                        Object.prototype.hasOwn, Number.prototype.toClamped,
//                        Map.prototype.getOrDefault, Date.prototype.toUnix,
//                        Promise.prototype.finally, globalThis.fetch,
//                        globalThis.structuredClone, window.__APP_BUS__
//                        — each written by ≥2 packages
//   • event-listeners  — window:resize/scroll/load/beforeunload,
//                        document:click/keydown/visibilitychange,
//                        self:message, process:unhandledRejection — each ≥2
//
// OSV needs only name@version from the lockfile (it queries osv.dev over the
// network), so the real-vuln packages ship with stub source on disk. The
// synthetic collision packages carry real source for the AST scanners.
//
// NOTE: the `osv` scanner requires network access to return findings.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface LabPackage {
  key: string; // lockfile key, relative to root
  name: string;
  version: string;
  source: string; // index.js contents
  note?: string; // why it's here (dev reference)
}

export const LAB_PACKAGES: LabPackage[] = [
  // ── real, known-vulnerable (OSV) — stub source ──
  {
    key: "node_modules/lodash",
    name: "lodash",
    version: "4.17.11",
    source: "module.exports = {};",
    note: "prototype pollution, ReDoS, command injection CVEs",
  },
  {
    key: "node_modules/minimist",
    name: "minimist",
    version: "0.0.8",
    source: "module.exports = function(){};",
    note: "prototype pollution CVE",
  },
  {
    key: "node_modules/marked",
    name: "marked",
    version: "0.3.6",
    source: "module.exports = {};",
    note: "ReDoS CVEs",
  },
  {
    key: "node_modules/handlebars",
    name: "handlebars",
    version: "4.0.11",
    source: "module.exports = {};",
    note: "RCE / prototype pollution CVEs",
  },
  // second copy of lodash, older version → version-conflict + more OSV hits
  {
    key: "node_modules/marked/node_modules/lodash",
    name: "lodash",
    version: "3.10.1",
    source: "module.exports = {};",
    note: "duplicate lodash version",
  },

  // ── extra version conflicts (duplicate names @ different versions) ──
  {
    key: "node_modules/react",
    name: "react",
    version: "18.2.0",
    source: "module.exports = {};",
    note: "react version-conflict (top level)",
  },
  {
    key: "node_modules/handlebars/node_modules/react",
    name: "react",
    version: "16.8.0",
    source: "module.exports = {};",
    note: "react version-conflict (nested)",
  },
  {
    key: "node_modules/marked/node_modules/react",
    name: "react",
    version: "17.0.2",
    source: "module.exports = {};",
    note: "react version-conflict (third copy)",
  },
  {
    key: "node_modules/express",
    name: "express",
    version: "4.18.2",
    source: "module.exports = {};",
    note: "express version-conflict (top level)",
  },
  {
    key: "node_modules/handlebars/node_modules/express",
    name: "express",
    version: "4.16.0",
    source: "module.exports = {};",
    note: "express version-conflict (nested)",
  },
  {
    key: "node_modules/minimist/node_modules/lodash",
    name: "lodash",
    version: "2.4.2",
    source: "module.exports = {};",
    note: "third lodash version → 3-way version-conflict",
  },
  {
    key: "node_modules/chalk",
    name: "chalk",
    version: "5.3.0",
    source: "module.exports = {};",
    note: "chalk version-conflict (top level)",
  },
  {
    key: "node_modules/handlebars/node_modules/chalk",
    name: "chalk",
    version: "2.4.2",
    source: "module.exports = {};",
    note: "chalk version-conflict (nested)",
  },
  {
    key: "node_modules/axios",
    name: "axios",
    version: "1.6.0",
    source: "module.exports = {};",
    note: "axios version-conflict (top level)",
  },
  {
    key: "node_modules/marked/node_modules/axios",
    name: "axios",
    version: "0.21.1",
    source: "module.exports = {};",
    note: "axios version-conflict (nested)",
  },
  {
    key: "node_modules/express/node_modules/axios",
    name: "axios",
    version: "0.27.2",
    source: "module.exports = {};",
    note: "axios version-conflict (third copy)",
  },
  {
    key: "node_modules/moment",
    name: "moment",
    version: "2.29.4",
    source: "module.exports = {};",
    note: "moment version-conflict (top level)",
  },
  {
    key: "node_modules/handlebars/node_modules/moment",
    name: "moment",
    version: "2.24.0",
    source: "module.exports = {};",
    note: "moment version-conflict (nested)",
  },
  {
    key: "node_modules/react/node_modules/react",
    name: "react",
    version: "15.6.2",
    source: "module.exports = {};",
    note: "fourth react version → 4-way version-conflict",
  },

  // ── synthetic collision packages (AST scanners) — real source ──
  {
    key: "node_modules/shimmy-a",
    name: "shimmy-a",
    version: "1.0.0",
    source: `
      // polyfill-style monkey patch + a global listener
      Array.prototype.flat = function () { return this; };
      Array.prototype.at = function () { return this[0]; };
      String.prototype.trimStart = function () { return this; };
      Object.prototype.hasOwn = function () { return false; };
      globalThis.fetch = function () {};
      window.__APP_BUS__ = {};
      window.addEventListener("resize", function () {});
      window.addEventListener("scroll", function () {});
      window.addEventListener("beforeunload", function () {});
      document.addEventListener("click", function () {});
      document.addEventListener("keydown", function () {});
    `,
    note: "global-state + event-listeners collision source",
  },
  {
    key: "node_modules/shimmy-b",
    name: "shimmy-b",
    version: "1.2.0",
    source: `
      // collides with shimmy-a on Array.prototype.flat, String.prototype.trimStart
      Array.prototype.flat = function () { return []; };
      Array.prototype.at = function () { return null; };
      String.prototype.trimStart = function () { return ""; };
      Object.prototype.hasOwn = function () { return true; };
      Object.defineProperty(Number.prototype, "toClamped", { value: function () {} });
      globalThis.__SHIMMY__ = true;
      window.__APP_BUS__ = { patched: true };
      window.addEventListener("scroll", function () {});
      window.addEventListener("beforeunload", function () {});
      document.addEventListener("keydown", function () {});
    `,
    note: "global-state collision source",
  },
  {
    key: "node_modules/shimmy-c",
    name: "shimmy-c",
    version: "3.1.0",
    source: `
      // collides with shimmy-a/b on fetch + Number.prototype.toClamped, adds Promise patch
      globalThis.fetch = async function () {};
      Object.defineProperty(Number.prototype, "toClamped", { value: function () { return 0; } });
      Object.prototype.hasOwn = function () {};
      Promise.prototype.finally = function () { return this; };
      Array.prototype.at = function () {};
      window.__APP_BUS__ = null;
      window.addEventListener("load", function () {});
      window.addEventListener("beforeunload", function () {});
      document.addEventListener("click", function () {});
      document.addEventListener("keydown", function () {});
    `,
    note: "global-state + event-listeners collision source",
  },
  {
    key: "node_modules/shimmy-d",
    name: "shimmy-d",
    version: "0.9.0",
    source: `
      // fresh globals + collisions on Map/Date prototypes and process listeners
      Map.prototype.getOrDefault = function () {};
      Date.prototype.toUnix = function () { return 0; };
      globalThis.structuredClone = function () {};
      Promise.prototype.finally = function () {};
      String.prototype.trimStart = function () {};
      process.addEventListener("unhandledRejection", function () {});
      window.addEventListener("resize", function () {});
    `,
    note: "global-state + event-listeners collision source",
  },
  {
    key: "node_modules/shimmy-e",
    name: "shimmy-e",
    version: "2.2.2",
    source: `
      // collides with shimmy-d on Map/Date prototypes + structuredClone + process
      Map.prototype.getOrDefault = function () { return null; };
      Date.prototype.toUnix = function () { return 1; };
      globalThis.structuredClone = function () { return {}; };
      process.addEventListener("unhandledRejection", function () {});
      document.addEventListener("keydown", function () {});
    `,
    note: "global-state + event-listeners collision source",
  },
  {
    key: "node_modules/listen-x",
    name: "listen-x",
    version: "2.0.0",
    source: `
      // collides with shimmy-a on window:resize / window:scroll
      window.addEventListener("resize", function () {});
      window.addEventListener("scroll", function () {});
      window.addEventListener("beforeunload", function () {});
      document.addEventListener("visibilitychange", function () {});
      document.addEventListener("keydown", function () {});
      Promise.prototype.finally = function () {};
    `,
    note: "event-listeners collision source",
  },
  {
    key: "node_modules/listen-y",
    name: "listen-y",
    version: "1.4.0",
    source: `
      // collides with shimmy-c on window:load, listen-x on visibilitychange
      window.addEventListener("load", function () {});
      window.addEventListener("resize", function () {});
      document.addEventListener("visibilitychange", function () {});
      document.addEventListener("click", function () {});
      self.addEventListener("message", function () {});
    `,
    note: "event-listeners collision source",
  },
  {
    key: "node_modules/listen-z",
    name: "listen-z",
    version: "0.3.0",
    source: `
      // collides broadly: scroll, load, message, unhandledRejection
      window.addEventListener("scroll", function () {});
      window.addEventListener("load", function () {});
      self.addEventListener("message", function () {});
      process.addEventListener("unhandledRejection", function () {});
    `,
    note: "event-listeners collision source",
  },
];

export function buildVulnLab(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const packagesMap: Record<string, { version: string }> = {
    "": { version: "1.0.0" },
  };

  for (const pkg of LAB_PACKAGES) {
    const dir = join(root, pkg.key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name, version: pkg.version, main: "index.js" }, null, 2),
    );
    writeFileSync(join(dir, "index.js"), pkg.source);
    packagesMap[pkg.key] = { version: pkg.version };
  }

  const lockfile = {
    name: "vuln-lab",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: packagesMap,
  };

  const lockPath = join(root, "package-lock.json");
  writeFileSync(lockPath, JSON.stringify(lockfile, null, 2));
  return lockPath;
}

if (process.argv[1] && process.argv[1].endsWith("build-vuln-lab.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".vuln-lab");
  const p = buildVulnLab(dir);
  console.log("vuln-lab built at", dir);
  console.log("lockfile:", p);
  console.log("\nexpect: osv (many) · version-conflict (lodash x3, react x4, express x2, axios x3, chalk x2, moment x2) · global-state (~10 targets) · event-listeners (~9 targets)");
}
