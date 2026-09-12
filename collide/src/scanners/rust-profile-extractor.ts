// scanners/rust-profile-extractor.ts
// Extract collision-relevant targets from Rust source. Two buckets, mirroring
// the npm PackageProfile shape:
//   writes     — process-global resources that clobber/conflict on duplicate
//                registration (the "resource sharing" analog)
//   listeners  — process-level "set-once" hooks (the event-listener analog)
//
// This is a HEURISTIC pattern scan, not a full Rust AST parse. Node has no native
// syn/rustc; a compiler-grade walk would need a bundled Rust helper or a
// tree-sitter-rust WASM parser (see docs/ecosystems/rust-cargo.md §2). The
// patterns below are syntactically distinctive enough that regex extraction
// gives strong signal for the high-value cases: two crates each defining a
// #[global_allocator], both calling log::set_logger, both installing a panic
// hook, etc. — all guaranteed process-wide conflicts.

import type { PackageProfile } from "./shared-ast-extractor";

/** Strip // line comments and block comments to avoid matching inside them. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** First double-quoted string literal inside an argument blob, or null. */
function firstStringLit(args: string): string | null {
  const m = args.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

export function extractRustProfile(source: string): PackageProfile {
  const src = stripComments(source);
  const writes = new Set<string>();
  const listeners = new Set<string>();

  // ── #[global_allocator] — only ONE allowed per process; two crates defining
  //    one is a hard conflict. The attribute is the distinctive marker.
  if (/#\s*\[\s*global_allocator\s*\]/.test(src)) {
    writes.add("global-allocator");
  }

  // ── #[panic_handler] (no_std) — only ONE allowed per binary; duplicate fails
  //    the build, but surfacing it early is valuable.
  if (/#\s*\[\s*panic_handler\s*\]/.test(src)) {
    writes.add("panic-handler");
  }

  // ── std::env::set_var("NAME", …) — writes a process-global env var; two crates
  //    writing the same var race (last write wins). Capture the var NAME.
  for (const m of src.matchAll(/\benv::set_var\s*\(([^;{}]*?)\)/g)) {
    const name = firstStringLit(m[1]);
    if (name) writes.add(`env:${name}`);
  }

  // ── std::panic::set_hook(…) — process-wide panic hook; last setter wins.
  if (/\bpanic::set_hook\s*\(/.test(src)) {
    listeners.add("panic-hook");
  }

  // ── log::set_logger / set_boxed_logger / set_logger_racy — the global logger
  //    can be set only ONCE per process; two crates trying it → runtime error.
  if (/\b(?:set_boxed_logger|set_logger(?:_racy)?)\s*\(/.test(src)) {
    listeners.add("logger");
  }

  // ── tracing::subscriber::set_global_default(…) — the global subscriber is
  //    also set-once; two crates installing one collide at runtime.
  if (/\bset_global_default\s*\(/.test(src)) {
    listeners.add("tracing-subscriber");
  }

  // ── signal handlers — signal_hook register(...) / libc::signal(...) /
  //    sigaction(...). Capture each SIG* identifier in the call args; two crates
  //    handling the same signal compete process-wide.
  for (const m of src.matchAll(
    /\b(?:libc::signal|sigaction|signal_hook[\w:]*register\w*)\s*\(([^;{}]*?)\)/g,
  )) {
    for (const sig of m[1].matchAll(/\bSIG([A-Z0-9]+)\b/g)) {
      listeners.add(`signal:SIG${sig[1]}`);
    }
  }

  return { writes: [...writes], listeners: [...listeners] };
}
