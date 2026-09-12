// test/composer-lab.test.ts
// Test environment for the PHP (Composer) pipeline. Everything here is offline
// and deterministic: it builds a synthetic composer.lock + fake vendor/ tree
// (test/build-composer-lab.ts) and exercises the composer parser, name/version
// normalization, the version-conflict scanner, the heuristic source extractor,
// the collision scanners, and the CLI end-to-end via `--only=version-conflict`
// (which needs no network).
//
// The `osv` scanner requires network access, so it is not asserted here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildComposerLab } from "./build-composer-lab";
import {
  normalizeComposerName,
  normalizeComposerVersion,
  parseComposerLock,
  parseComposerManifest,
} from "../src/core/composer-manifest";
import { versionConflictScanner } from "../src/scanners/version-conflict";
import { extractPhpProfile } from "../src/scanners/php-profile-extractor";
import { phpGlobalStateScanner, phpHooksScanner } from "../src/scanners/php-collision";
import type { Finding } from "../src/core/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.ts");

let ROOT: string;
let LOCK: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-composerlab-"));
  LOCK = buildComposerLab(ROOT);
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("composer sandbox (build-composer-lab)", () => {
  test("writes composer.lock with packages + packages-dev", () => {
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    assert.ok(Array.isArray(lock.packages));
    assert.ok(Array.isArray(lock["packages-dev"]));
    assert.ok(lock.packages.some((p: { name: string }) => p.name === "guzzlehttp/guzzle"));
  });
});

describe("normalizeComposerName / normalizeComposerVersion", () => {
  test("lowercases the vendor/package slug", () => {
    assert.equal(normalizeComposerName("Symfony/Console"), "symfony/console");
    assert.equal(normalizeComposerName("  Monolog/Monolog  "), "monolog/monolog");
  });
  test("strips a leading v from versions", () => {
    assert.equal(normalizeComposerVersion("v6.3.4"), "6.3.4");
    assert.equal(normalizeComposerVersion("3.4.0"), "3.4.0");
    // a bare "v" without a following digit is left alone
    assert.equal(normalizeComposerVersion("version1"), "version1");
  });
});

describe("parseComposerLock", () => {
  test("iterates packages + packages-dev and skips dev/branch versions", () => {
    const pkgs = parseComposerLock(
      JSON.stringify({
        packages: [
          { name: "Symfony/Console", version: "v6.3.4" },
          { name: "monolog/monolog", version: "3.4.0" },
          { name: "some/branch", version: "dev-main" },
        ],
        "packages-dev": [
          { name: "phpunit/phpunit", version: "10.3.2" },
          { name: "another/branch", version: "1.2.x-dev" },
        ],
      }),
    );
    const ids = pkgs.map((p) => `${p.name}@${p.version}`);
    assert.ok(ids.includes("symfony/console@6.3.4")); // lowercased + v stripped
    assert.ok(ids.includes("monolog/monolog@3.4.0"));
    assert.ok(ids.includes("phpunit/phpunit@10.3.2")); // from packages-dev
    // branch/dev versions are not concrete releases → skipped
    assert.ok(!ids.some((i) => i.startsWith("some/branch")));
    assert.ok(!ids.some((i) => i.startsWith("another/branch")));
  });

  test("returns [] on malformed JSON", () => {
    assert.deepEqual(parseComposerLock("{not json"), []);
  });
});

describe("parseComposerManifest (lab composer.lock)", () => {
  test("parses both sections and resolves vendor source paths", () => {
    const pkgs = parseComposerManifest(LOCK);
    assert.ok(pkgs.some((p) => p.name === "guzzlehttp/guzzle" && p.version === "6.5.0"));
    // both monolog pins present (1.0.0 and 2.0.0) across the two sections
    const monolog = pkgs.filter((p) => p.name === "monolog/monolog");
    assert.equal(monolog.length, 2);
    // collision packages resolved to source in the fake vendor/ tree
    const alpha = pkgs.find((p) => p.name === "collide/alpha")!;
    assert.ok(alpha.sourcePath, "expected sourcePath resolved from vendor/");
  });
});

describe("versionConflictScanner (reused for PHP)", () => {
  test("flags the duplicate monolog/monolog versions", async () => {
    const pkgs = parseComposerManifest(LOCK);
    const findings = await versionConflictScanner.scan(pkgs);
    const monolog = findings.find((f) => f.target === "monolog/monolog");
    assert.ok(monolog, "expected a monolog/monolog version conflict");
    assert.equal(monolog!.owners.length, 2);
  });

  test("does not flag clean single-version packages", async () => {
    const pkgs = parseComposerManifest(LOCK);
    const findings = await versionConflictScanner.scan(pkgs);
    assert.ok(!findings.some((f) => f.target === "psr/log"));
    assert.ok(!findings.some((f) => f.target === "guzzlehttp/guzzle"));
  });
});

describe("extractPhpProfile (heuristic source scan)", () => {
  test("extracts root-namespace functions, define/ini/$GLOBALS and hooks", () => {
    const profile = extractPhpProfile(`<?php
define('APP_MODE', 'prod');
ini_set('memory_limit', '256M');
$GLOBALS['registry'] = [];

function dd($value) { var_dump($value); }

set_error_handler('h');
set_exception_handler('eh');
register_shutdown_function('shutdown');
spl_autoload_register('loader');
pcntl_signal(SIGTERM, 'handler');
`);
    assert.ok(profile.writes.includes("function:dd"));
    assert.ok(profile.writes.includes("define:APP_MODE"));
    assert.ok(profile.writes.includes("ini:memory_limit"));
    assert.ok(profile.writes.includes("globals:registry"));
    assert.ok(profile.listeners.includes("error-handler:set"));
    assert.ok(profile.listeners.includes("exception-handler:set"));
    assert.ok(profile.listeners.includes("shutdown:register"));
    assert.ok(profile.listeners.includes("autoload:register"));
    assert.ok(profile.listeners.includes("signal:SIGTERM"));
  });

  test("does not flag namespaced functions or class methods as global", () => {
    const profile = extractPhpProfile(`<?php
namespace App\\Service;
function helper() {}
class Foo {
    public function bar() {}
    private static function baz() {}
}
`);
    assert.ok(!profile.writes.some((w) => w.startsWith("function:")));
  });

  test("ignores patterns that only appear in comments", () => {
    const profile = extractPhpProfile(`<?php
// function ghost() {}
# define('GHOST', 1);
/* set_error_handler('ghost'); */
`);
    assert.deepEqual(profile.writes, []);
    assert.deepEqual(profile.listeners, []);
  });
});

describe("phpGlobalStateScanner (PHP source collisions)", () => {
  test("flags dump()/COLLIDE_MODE/memory_limit written by 2+ packages", async () => {
    const pkgs = parseComposerManifest(LOCK);
    const findings = await phpGlobalStateScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));

    for (const target of ["function:dump", "define:COLLIDE_MODE", "ini:memory_limit"]) {
      const f = byTarget.get(target);
      assert.ok(f, `expected a collision on ${target}`);
      assert.equal(f!.owners.length, 2);
      assert.equal(f!.severity, "high");
    }
    // the fatal-redeclaration message is used for function collisions
    assert.match(byTarget.get("function:dump")!.message, /fatal redeclaration/);
  });
});

describe("phpHooksScanner (PHP hook collisions)", () => {
  test("flags error handler / shutdown / autoload registered by 2+ packages", async () => {
    const pkgs = parseComposerManifest(LOCK);
    const findings = await phpHooksScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));
    assert.ok(byTarget.get("error-handler:set"), "expected error-handler:set collision");
    assert.ok(byTarget.get("shutdown:register"), "expected shutdown:register collision");
    assert.ok(byTarget.get("autoload:register"), "expected autoload:register collision");
    assert.equal(byTarget.get("error-handler:set")!.owners.length, 2);
  });
});

describe("collide scan (PHP CLI e2e, offline)", () => {
  function runCli(args: string[]): string {
    return execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, COLLIDE_DB_PATH: join(ROOT, "composer-cli-cache.db") },
    });
  }

  test("--only=version-conflict --format=json reports the monolog conflict", () => {
    const out = runCli(["scan", LOCK, "--only=version-conflict", "--format=json"]);
    const parsed = JSON.parse(out) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(parsed) ? parsed : parsed.findings ?? [];
    const monolog = findings.find((f) => f.target === "monolog/monolog");
    assert.ok(monolog, `expected monolog conflict in: ${out}`);
    assert.equal(monolog!.scanner, "version-conflict");
  });
});
