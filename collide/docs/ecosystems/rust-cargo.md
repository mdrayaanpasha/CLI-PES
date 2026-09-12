# Rust (Cargo / crates.io) — support plan

> Prerequisite: shared plumbing in [`README.md`](./README.md).
>
> OSV ecosystem string: **`crates.io`**

Rust is the easiest ecosystem after npm: `Cargo.lock` is fully resolved, always
pinned, and version conflicts (multiple semver-incompatible copies of one crate) are
a *real, common* problem the version-conflict scanner catches for free.

---

## 1. Manifest to parse

Only `Cargo.lock` (TOML). Ignore `Cargo.toml` — it holds ranges, not resolved
versions.

```toml
[[package]]
name = "serde"
version = "1.0.193"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "libc"
version = "0.2.150"
```

Parse each `[[package]]` → `{ name, version, ecosystem: "crates.io" }`.

**Skip path/git deps**: entries whose `source` is missing or starts with `git+` /
`path+` aren't on crates.io, so OSV can't match them — still count them for
version-conflict, but tag so OSV skips them (or just let OSV return nothing).

No name normalization needed — crate names are already canonical (lowercase, `-`).

---

## 2. Collision analysis analog

Rust has no runtime monkeypatching, but process-global collisions still exist:

### `rust-global-state`
| Target class | Example | Hazard |
|---|---|---|
| `#[global_allocator]` | two crates define one | link error / silent override |
| `#[panic_handler]` (no_std) | duplicate | build fails, but worth surfacing |
| Global statics | `static mut`, `lazy_static!`, `once_cell` singletons | shared mutable process state |
| Env var writes | `std::env::set_var(...)` | process-global |

### `rust-hooks` (event-listener analog)
| Target class | API |
|---|---|
| Panic hook | `std::panic::set_hook(...)` |
| Signal handlers | `signal_hook`, raw `libc::signal` |
| Logger init | `log::set_logger(...)`, `set_boxed_logger` — **only one allowed per process** |
| Global subscriber | `tracing::subscriber::set_global_default(...)` — same |

`log::set_logger` and `tracing`'s global default are the standout cases: the API
itself is "set once", so two dependencies both trying it is a guaranteed runtime
conflict — a high-value finding.

### Extraction mechanism
Cargo crate sources live under `~/.cargo/registry/src/**/<crate>-<version>/`, not next
to the lockfile, so resolving `sourcePath` is harder than npm. Options:

1. **osv + version-conflict only** (v1). No source analysis. Already high value in
   Rust because duplicate-version detection is so relevant.
2. Add source analysis later via `syn`-style parsing — but that means a Rust-side
   tool or a `tree-sitter-rust` WASM parser on the Node side, plus resolving the
   cargo registry cache path. Defer.

Recommendation: ship v1 as **osv + version-conflict**. The collision scanner is a
stretch goal given source resolution cost.

---

## 3. Test lab

`test/build-cargo-lab.ts`:
- **osv**: pin crates with RUSTSEC advisories present in OSV (e.g. an old `time`,
  `openssl`, or `smallvec` version).
- **version-conflict**: two `[[package]]` entries for the same crate at
  semver-incompatible versions (`0.2.x` and `0.1.x`) — extremely realistic.
- **collision**: deferred until source analysis lands.

---

## 4. Open questions

- Worth resolving `~/.cargo/registry` to enable source scanning, or is
  osv+version-conflict enough for Rust?
- Report semver-*compatible* duplicates (`1.0.1` vs `1.0.2`, which Cargo would
  normally unify) differently from incompatible ones (`0.1` vs `0.2`)?
