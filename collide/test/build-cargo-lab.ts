// test/build-cargo-lab.ts
// Builds a deterministic synthetic Rust project (Cargo.lock + a fake cargo
// registry source cache) whose contents we control exactly, so the Rust
// pipeline's output is predictable:
//
//   • osv              — real crate names pinned at versions with known RUSTSEC
//                        advisories (e.g. an old `time`, `smallvec`, `openssl`).
//   • version-conflict — two [[package]] entries for the same crate at
//                        semver-incompatible versions (0.7.x and 0.8.x).
//   • global-state     — crates that claim the same process-global resource
//                        (#[global_allocator], env::set_var) — see overlaps below.
//   • event-listeners  — crates that install the same set-once/process hook
//                        (logger, panic hook, signal) — see overlaps below.
//
// OSV needs only crate name@version (queried over the network). The collision
// scanners read crate source from the cargo registry cache — which does NOT sit
// beside the lockfile — so source-carrying crates are materialized into a fake
// cache under `root/cargo-src`. Point COLLIDE_CARGO_SRC at that dir so the
// locator resolves lab crates. See docs/ecosystems/rust-cargo.md.
//
// NOTE: the `osv` scanner requires network access; the version-conflict and
// collision scanners are fully offline and deterministic.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";

export interface CargoLabCrate {
  name: string;
  /** semver version, no leading `v` in Cargo.lock */
  version: string;
  /** why it's in the lab (dev reference) */
  note?: string;
  /**
   * `source` value written into Cargo.lock. Defaults to the crates.io registry.
   * Set to a `git+…` string or null (omit the field) to model a non-registry
   * dependency that OSV / our parser should skip.
   */
  source?: string | null;
  /** synthetic .rs source files (filename → contents) written into the fake
   *  cargo registry cache; drives the global-state / event-listeners scanners */
  sourceFiles?: Record<string, string>;
}

export const CARGO_LAB_CRATES: CargoLabCrate[] = [
  // ── real, known-vulnerable (OSV / RUSTSEC) ──
  {
    name: "time",
    version: "0.1.44",
    note: "RUSTSEC-2020-0071: segfault in time 0.1.x localtime handling",
  },
  {
    name: "smallvec",
    version: "1.6.0",
    note: "RUSTSEC-2021-0003: buffer overflow in smallvec < 1.6.1",
  },
  {
    name: "openssl",
    version: "0.10.35",
    note: "older openssl bindings with published advisories",
  },

  // ── version-conflict: same crate at semver-incompatible versions ──
  {
    name: "rand",
    version: "0.7.3",
    note: "version conflict: rand 0.7 (semver-incompatible with 0.8)",
  },
  {
    name: "rand",
    version: "0.8.5",
    note: "version conflict: rand 0.8 coexisting with 0.7",
  },

  // ── clean transitive deps (must NOT be flagged as conflicts) ──
  {
    name: "libc",
    version: "0.2.150",
    note: "clean dep — single version",
  },
  {
    name: "serde",
    version: "1.0.193",
    note: "clean dep — single version",
  },

  // ── non-registry deps: parser + OSV must skip these ──
  {
    name: "localcrate",
    version: "0.0.0",
    note: "path/workspace dep — no source field, must be skipped",
    source: null,
  },
  {
    name: "gitdep",
    version: "0.1.0",
    note: "git dep — git+ source, must be skipped",
    source: "git+https://github.com/example/gitdep#abc123",
  },

  // ── collision fixtures — carry real Rust source in the fake registry cache ──
  // Designed overlaps (each touched by exactly 2 crates):
  //   global-allocator → acme-alloc + acme-jemalloc   (global-state)
  //   env:APP_MODE     → acme-alloc + acme-logsetup   (global-state)
  //   logger           → acme-logsetup + acme-tracer  (event-listeners)
  //   panic-hook       → acme-tracer + acme-siglib    (event-listeners)
  //   signal:SIGTERM   → acme-logsetup + acme-siglib  (event-listeners)
  // tracing-subscriber is touched by only acme-tracer → must NOT be flagged.
  {
    name: "acme-alloc",
    version: "1.0.0",
    note: "defines #[global_allocator] and writes APP_MODE",
    sourceFiles: {
      "lib.rs": `use std::alloc::System;
use std::env;

#[global_allocator]
static GLOBAL: System = System;

pub fn configure() {
    env::set_var("APP_MODE", "prod");
}
`,
    },
  },
  {
    name: "acme-jemalloc",
    version: "0.5.0",
    note: "also defines #[global_allocator] → collides with acme-alloc",
    sourceFiles: {
      "lib.rs": `use jemallocator::Jemalloc;

#[global_allocator]
static ALLOC: Jemalloc = Jemalloc;
`,
    },
  },
  {
    name: "acme-logsetup",
    version: "0.4.0",
    note: "installs a global logger, writes APP_MODE, handles SIGTERM",
    sourceFiles: {
      "lib.rs": `use std::env;

pub fn init() {
    log::set_boxed_logger(Box::new(MyLogger)).unwrap();
    env::set_var("APP_MODE", "debug");
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Default::default()).unwrap();
}

struct MyLogger;
`,
    },
  },
  {
    name: "acme-tracer",
    version: "0.2.0",
    note: "sets a global logger + tracing subscriber + panic hook",
    sourceFiles: {
      "lib.rs": `use std::panic;

pub fn init() {
    log::set_logger(&LOGGER).unwrap();
    tracing::subscriber::set_global_default(make_subscriber()).unwrap();
    panic::set_hook(Box::new(|info| {
        eprintln!("panic: {:?}", info);
    }));
}
`,
    },
  },
  {
    name: "acme-siglib",
    version: "1.1.0",
    note: "installs a panic hook and a raw SIGTERM handler",
    sourceFiles: {
      "lib.rs": `use std::panic;

pub fn init() {
    panic::set_hook(Box::new(|_| {}));
    unsafe {
        libc::signal(libc::SIGTERM, handle as usize);
    }
}

extern "C" fn handle(_: i32) {}
`,
    },
  },
];

/** Render a Cargo.lock from the lab crates. */
function renderCargoLock(crates: CargoLabCrate[]): string {
  const blocks = [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    'version = 3',
    "",
  ];
  for (const crate of crates) {
    const lines = [
      "[[package]]",
      `name = "${crate.name}"`,
      `version = "${crate.version}"`,
    ];
    // undefined → default crates.io registry; null → omit source (path dep)
    const source = crate.source === undefined ? CRATES_IO : crate.source;
    if (source !== null) lines.push(`source = "${source}"`);
    blocks.push(lines.join("\n"), "");
  }
  return blocks.join("\n");
}

/** Where the fake cargo source cache lives for a given lab root. Point
 *  COLLIDE_CARGO_SRC at this so the collision scanners resolve lab crates. */
export function cargoSrcCachePath(root: string): string {
  return join(root, "cargo-src");
}

/**
 * Materialize the fake cargo registry source cache under `root/cargo-src`,
 * writing each crate's synthetic source at `<crate>-<version>/`. Crates without
 * `sourceFiles` contribute nothing (manifest-only, like the real vuln crates).
 */
export function buildCargoSrcCache(root: string): string {
  const cache = cargoSrcCachePath(root);
  for (const c of CARGO_LAB_CRATES) {
    if (!c.sourceFiles) continue;
    const dir = join(cache, `${c.name}-${c.version}`);
    mkdirSync(dir, { recursive: true });
    for (const [file, contents] of Object.entries(c.sourceFiles)) {
      writeFileSync(join(dir, file), contents);
    }
  }
  return cache;
}

/**
 * Materialize the Cargo lab into `root`. Returns the path to Cargo.lock; a fake
 * cargo source cache (`root/cargo-src`) is written alongside it. Idempotent:
 * wipes `root` first.
 */
export function buildCargoLab(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const lockPath = join(root, "Cargo.lock");
  writeFileSync(lockPath, renderCargoLock(CARGO_LAB_CRATES));
  buildCargoSrcCache(root);
  return lockPath;
}

// Allow running standalone: `tsx test/build-cargo-lab.ts <dir>` to inspect it.
if (process.argv[1] && process.argv[1].endsWith("build-cargo-lab.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".cargo-lab");
  const p = buildCargoLab(dir);
  console.log("cargo-lab built at", dir);
  console.log("Cargo.lock:", p);
  console.log("cargo-src:", cargoSrcCachePath(dir));
  console.log(
    "\nexpect: osv (time, smallvec, openssl) · " +
      "version-conflict (rand 0.7 vs 0.8) · " +
      "global-state (global-allocator, env:APP_MODE) · " +
      "event-listeners (logger, panic-hook, signal:SIGTERM)",
  );
}
