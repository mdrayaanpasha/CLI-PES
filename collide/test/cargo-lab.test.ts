// test/cargo-lab.test.ts
// Test environment for the Rust (Cargo) pipeline. Everything here is offline and
// deterministic: it builds a synthetic Cargo.lock lab (test/build-cargo-lab.ts)
// and exercises the Cargo parser, the (shared) version-conflict scanner, and the
// CLI end-to-end via `--only=version-conflict` (which needs no network).
//
// The `osv` scanner requires network access, so it is not asserted here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildCargoLab, cargoSrcCachePath } from "./build-cargo-lab";
import { parseCargoLock, parseCargoManifest, isCargoManifest } from "../src/core/cargo-manifest";
import { versionConflictScanner } from "../src/scanners/version-conflict";
import { extractRustProfile } from "../src/scanners/rust-profile-extractor";
import {
  rustGlobalStateScanner,
  rustHooksScanner,
} from "../src/scanners/rust-collision";
import type { Finding } from "../src/core/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.ts");

let ROOT: string;
let CARGO_LOCK: string;
let CARGO_SRC: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-cargolab-"));
  CARGO_LOCK = buildCargoLab(ROOT);
  CARGO_SRC = cargoSrcCachePath(ROOT);
  // point the source scanners at the lab's fake cargo registry cache
  process.env.COLLIDE_CARGO_SRC = CARGO_SRC;
});
after(() => {
  delete process.env.COLLIDE_CARGO_SRC;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("cargo sandbox (build-cargo-lab)", () => {
  test("writes a Cargo.lock with registry + non-registry crates", () => {
    const lock = readFileSync(CARGO_LOCK, "utf8");
    assert.match(lock, /name = "rand"/);
    assert.match(lock, /registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index/);
    assert.match(lock, /git\+https:\/\/github\.com\/example\/gitdep/);
  });
});

describe("isCargoManifest", () => {
  test("matches Cargo.lock only (not Cargo.toml)", () => {
    assert.ok(isCargoManifest("/some/path/Cargo.lock"));
    assert.ok(!isCargoManifest("/some/path/Cargo.toml"));
    assert.ok(!isCargoManifest("/some/path/go.sum"));
  });
});

describe("parseCargoLock", () => {
  test("parses each registry [[package]] into name@version", () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const rand07 = pkgs.find((p) => p.name === "rand" && p.version === "0.7.3");
    assert.ok(rand07, "expected rand 0.7.3");
    assert.equal(rand07!.version, "0.7.3"); // no leading `v`
    const serde = pkgs.find((p) => p.name === "serde");
    assert.equal(serde!.version, "1.0.193");
  });

  test("skips git+ and sourceless (path/workspace) crates", () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    assert.ok(!pkgs.some((p) => p.name === "localcrate"), "path dep must be skipped");
    assert.ok(!pkgs.some((p) => p.name === "gitdep"), "git dep must be skipped");
  });

  test("dedupes identical name@version entries", () => {
    const pkgs = parseCargoLock(
      [
        "[[package]]",
        'name = "dup"',
        'version = "1.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
        "[[package]]",
        'name = "dup"',
        'version = "1.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
      ].join("\n"),
    );
    assert.equal(pkgs.filter((p) => p.name === "dup").length, 1);
  });

  test("does not leak fields across package blocks", () => {
    // a sourceless crate followed by a registry crate must not inherit source
    const pkgs = parseCargoLock(
      [
        "[[package]]",
        'name = "local"',
        'version = "0.0.0"',
        "",
        "[[package]]",
        'name = "real"',
        'version = "2.0.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
      ].join("\n"),
    );
    assert.ok(!pkgs.some((p) => p.name === "local"));
    assert.ok(pkgs.some((p) => p.name === "real" && p.version === "2.0.0"));
  });
});

describe("versionConflictScanner (Rust)", () => {
  test("flags rand resolved to two semver-incompatible versions", async () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const findings = await versionConflictScanner.scan(pkgs);
    const rand = findings.find((f) => f.target === "rand");
    assert.ok(rand, "expected a rand version conflict");
    assert.equal(rand!.owners.length, 2);
    assert.ok(rand!.owners.includes("rand@0.7.3"));
    assert.ok(rand!.owners.includes("rand@0.8.5"));
  });

  test("does not flag clean single-version crates", async () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const findings = await versionConflictScanner.scan(pkgs);
    const targets = findings.map((f) => f.target);
    assert.ok(!targets.includes("serde"));
    assert.ok(!targets.includes("libc"));
  });
});

describe("extractRustProfile (heuristic source scan)", () => {
  test("extracts allocator / env writes and logger / panic / signal hooks", () => {
    const profile = extractRustProfile(`use std::{env, panic};

#[global_allocator]
static A: System = System;

pub fn init() {
    env::set_var("APP_MODE", "prod");
    log::set_boxed_logger(Box::new(L)).unwrap();
    tracing::subscriber::set_global_default(s).unwrap();
    panic::set_hook(Box::new(|_| {}));
    unsafe { libc::signal(libc::SIGTERM, h as usize); }
}
`);
    assert.ok(profile.writes.includes("global-allocator"));
    assert.ok(profile.writes.includes("env:APP_MODE"));
    assert.ok(profile.listeners.includes("logger"));
    assert.ok(profile.listeners.includes("tracing-subscriber"));
    assert.ok(profile.listeners.includes("panic-hook"));
    assert.ok(profile.listeners.includes("signal:SIGTERM"));
  });

  test("ignores patterns that only appear in comments", () => {
    const profile = extractRustProfile(`// #[global_allocator] not real
/* log::set_logger(&L); env::set_var("GHOST", "1"); */
`);
    assert.deepEqual(profile.writes, []);
    assert.deepEqual(profile.listeners, []);
  });
});

describe("rustGlobalStateScanner (Rust resource-sharing collisions)", () => {
  test("flags global-allocator and env:APP_MODE claimed by 2+ crates", async () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const findings = await rustGlobalStateScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));

    for (const target of ["global-allocator", "env:APP_MODE"]) {
      const f = byTarget.get(target);
      assert.ok(f, `expected a collision on ${target}`);
      assert.equal(f!.owners.length, 2);
      assert.equal(f!.severity, "high");
    }
  });
});

describe("rustHooksScanner (Rust hook collisions)", () => {
  test("flags logger / panic-hook / signal:SIGTERM registered by 2+ crates", async () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const findings = await rustHooksScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));

    for (const target of ["logger", "panic-hook", "signal:SIGTERM"]) {
      const f = byTarget.get(target);
      assert.ok(f, `expected a collision on ${target}`);
      assert.equal(f!.owners.length, 2);
    }
  });

  test("does not flag a set-once hook used by only one crate", async () => {
    const pkgs = parseCargoManifest(CARGO_LOCK);
    const findings = await rustHooksScanner.scan(pkgs);
    // tracing-subscriber is installed only by acme-tracer → single owner
    assert.ok(!findings.some((f) => f.target === "tracing-subscriber"));
  });
});

describe("collide scan (Rust CLI e2e, offline)", () => {
  function runCli(args: string[]): string {
    return execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, COLLIDE_DB_PATH: join(ROOT, "cargo-cli-cache.db") },
    });
  }

  test("--only=version-conflict --format=json reports the rand conflict", () => {
    const out = runCli([
      "scan",
      CARGO_LOCK,
      "--only=version-conflict",
      "--format=json",
    ]);
    const parsed = JSON.parse(out) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(parsed) ? parsed : parsed.findings ?? [];
    const rand = findings.find((f) => f.target === "rand");
    assert.ok(rand, `expected rand conflict in: ${out}`);
    assert.equal(rand!.scanner, "version-conflict");
  });

  test("--only=global-state,event-listeners reports source collisions", () => {
    const out = runCli([
      "scan",
      CARGO_LOCK,
      "--only=global-state,event-listeners",
      "--format=json",
    ]);
    const parsed = JSON.parse(out) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(parsed) ? parsed : parsed.findings ?? [];
    const targets = new Set(findings.map((f) => f.target));
    assert.ok(targets.has("global-allocator"), `expected global-allocator in: ${out}`);
    assert.ok(targets.has("logger"), `expected logger in: ${out}`);
  });
});
