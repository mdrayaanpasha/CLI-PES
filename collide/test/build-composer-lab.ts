// test/build-composer-lab.ts
// Builds a deterministic synthetic PHP (Composer) project engineered to trip
// every PHP scanner at once. See docs/ecosystems/php-composer.md §3.
//
//   • osv              — real package names pinned at known-vulnerable releases
//                        (guzzlehttp/guzzle 6.5.0, symfony/http-kernel 4.4.0,
//                        monolog/monolog 1.0.0 — all have advisories on OSV).
//   • version-conflict — the same package emitted twice at different versions
//                        (monolog/monolog 1.0.0 and 2.0.0) across the two lock
//                        sections.
//   • global-state     — two synthetic packages that both define a root-namespace
//                        function dump(), both define('COLLIDE_MODE', …) and both
//                        ini_set('memory_limit', …).
//   • event-listeners  — two synthetic packages that both set_error_handler(…),
//                        both register_shutdown_function(…) and both
//                        spl_autoload_register(…).
//
// OSV needs only name@version (it queries osv.dev over the network). The
// collision packages carry real .php source in a synthetic vendor/ tree so the
// heuristic source scanners resolve them.
//
// NOTE: the `osv` scanner requires network access to return findings; the
// version-conflict and collision scanners are fully offline and deterministic.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ComposerLabPackage {
  /** package slug as it appears in composer.lock (vendor/package) */
  name: string;
  /** exact version (a leading `v` is stripped by the parser) */
  version: string;
  /** which lock section it lives in */
  section: "packages" | "packages-dev";
  /** why it's in the lab (dev reference) */
  note?: string;
  /** synthetic .php source written into the fake vendor/<name>/ dir; drives the
   *  global-state / event-listeners scanners. Keyed by relative file path. */
  source?: Record<string, string>;
}

export const COMPOSER_LAB_PACKAGES: ComposerLabPackage[] = [
  // ── real, known-vulnerable (OSV) ──
  { name: "guzzlehttp/guzzle", version: "6.5.0", section: "packages", note: "CVEs in older guzzle" },
  { name: "symfony/http-kernel", version: "v4.4.0", section: "packages", note: "Symfony advisories" },

  // ── version-conflict: monolog/monolog present twice at different versions ──
  { name: "monolog/monolog", version: "1.0.0", section: "packages", note: "old monolog (dup)" },
  { name: "monolog/monolog", version: "2.0.0", section: "packages-dev", note: "duplicate → version conflict" },

  // ── clean dep — single version, must NOT be flagged ──
  { name: "psr/log", version: "1.1.4", section: "packages", note: "clean dep" },

  // ── collision fixtures — carry real PHP source in the fake vendor/ tree ──
  // Designed overlaps:
  //   function:dump         → alpha + beta   (global-state, fatal redeclaration)
  //   define:COLLIDE_MODE   → alpha + beta   (global-state)
  //   ini:memory_limit      → alpha + beta   (global-state)
  //   error-handler:set     → alpha + beta   (event-listeners)
  //   shutdown:register     → alpha + beta   (event-listeners)
  //   autoload:register     → alpha + beta   (event-listeners)
  {
    name: "collide/alpha",
    version: "1.0.0",
    section: "packages",
    note: "collides on dump(), COLLIDE_MODE, memory_limit, error handler, shutdown, autoload",
    source: {
      "src/helpers.php": `<?php

define('COLLIDE_MODE', 'alpha');
ini_set('memory_limit', '256M');

function dump($value)
{
    var_dump($value);
}

set_error_handler(function ($errno, $errstr) {
    return true;
});

register_shutdown_function(function () {
    // flush alpha
});

spl_autoload_register(function ($class) {
    // alpha autoloader
});
`,
    },
  },
  {
    name: "collide/beta",
    version: "0.9.0",
    section: "packages-dev",
    note: "collides on dump(), COLLIDE_MODE, memory_limit, error handler, shutdown, autoload",
    source: {
      "src/dump.php": `<?php

define('COLLIDE_MODE', 'beta');
ini_set('memory_limit', '512M');

function dump(...$vars)
{
    foreach ($vars as $v) {
        print_r($v);
    }
}

set_error_handler('beta_error_handler');
register_shutdown_function('beta_shutdown');
spl_autoload_register('beta_autoload');
`,
      // a namespaced file — its function must NOT be flagged as a root collision
      "src/Namespaced.php": `<?php

namespace Collide\\Beta;

function dump($value)
{
    // namespaced dump — scoped, does not collide with the global dump()
    return $value;
}
`,
    },
  },
];

/** Render composer.lock JSON from the lab packages. */
function renderComposerLock(pkgs: ComposerLabPackage[]): string {
  const toEntry = (p: ComposerLabPackage) => ({ name: p.name, version: p.version });
  const lock = {
    _readme: ["synthetic collide test lab — not a real project"],
    "content-hash": "collidelabhashplaceholder00000000",
    packages: pkgs.filter((p) => p.section === "packages").map(toEntry),
    "packages-dev": pkgs.filter((p) => p.section === "packages-dev").map(toEntry),
  };
  return JSON.stringify(lock, null, 2);
}

/** Where the fake vendor tree lives for a given lab root. */
export function vendorPath(root: string): string {
  return join(root, "vendor");
}

/**
 * Materialize the fake vendor/ tree, writing each collision package's synthetic
 * source at vendor/<vendor>/<package>/. Packages without `source` contribute
 * nothing (manifest-only, like the real vuln packages).
 */
export function buildVendor(root: string): string {
  const vendor = vendorPath(root);
  for (const p of COMPOSER_LAB_PACKAGES) {
    if (!p.source) continue;
    for (const [file, contents] of Object.entries(p.source)) {
      const full = join(vendor, ...p.name.split("/"), file);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }
  }
  return vendor;
}

/**
 * Materialize the composer lab into `root`. Returns the path to composer.lock; a
 * fake vendor/ tree is written alongside so the source scanners resolve the
 * collision packages. Idempotent: wipes `root` first.
 */
export function buildComposerLab(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const lockPath = join(root, "composer.lock");
  writeFileSync(lockPath, renderComposerLock(COMPOSER_LAB_PACKAGES));
  buildVendor(root);
  return lockPath;
}

// Allow running standalone: `tsx test/build-composer-lab.ts <dir>` to inspect it.
if (process.argv[1] && process.argv[1].endsWith("build-composer-lab.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".composer-lab");
  const p = buildComposerLab(dir);
  console.log("composer-lab built at", dir);
  console.log("composer.lock:", p);
  console.log(
    "\nexpect: osv (guzzle, http-kernel, monolog) · " +
      "version-conflict (monolog/monolog 1.0.0/2.0.0) · " +
      "global-state (function:dump, define:COLLIDE_MODE, ini:memory_limit) · " +
      "event-listeners (error-handler:set, shutdown:register, autoload:register)",
  );
}
