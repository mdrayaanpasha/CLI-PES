// scanners/go-profile-extractor.ts
// Extract collision-relevant targets from Go source. Two buckets, mirroring the
// npm PackageProfile shape:
//   writes     — package-global registrations that clobber/panic on duplicate
//   listeners  — process-level hooks (the Go analog of event listeners)
//
// This is a HEURISTIC pattern scan, not a full Go AST parse. Node has no native
// go/parser; a compiler-grade walk would need a bundled Go helper or
// tree-sitter-go (see docs/ecosystems/go-modules.md §3). The patterns below are
// syntactically distinctive enough that regex extraction gives strong signal
// for the high-value cases (duplicate flags, duplicate HTTP routes, duplicate
// expvar names — all of which panic or silently clobber at runtime).

import type { PackageProfile } from "./shared-ast-extractor";

/** Strip // line comments and /* block comments *\/ to avoid matching in them. */
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

export function extractGoProfile(source: string): PackageProfile {
  const src = stripComments(source);
  const writes = new Set<string>();
  const listeners = new Set<string>();

  // ── flag.String / Int / Bool / …Var(…) — duplicate flag name panics at start.
  //    The flag NAME is the first string literal in the call, for both the plain
  //    (flag.String("n", …)) and Var (flag.StringVar(&x, "n", …)) forms.
  for (const m of src.matchAll(/\bflag\.[A-Za-z]+\s*\(([^;{}]*?)\)/g)) {
    const name = firstStringLit(m[1]);
    if (name) writes.add(`flag:${name}`);
  }

  // ── http.HandleFunc / http.Handle — two libs claiming one route clobber.
  for (const m of src.matchAll(/\bhttp\.Handle(?:Func)?\s*\(([^;{}]*?)\)/g)) {
    const route = firstStringLit(m[1]);
    if (route) writes.add(`http-route:${route}`);
  }

  // ── expvar.Publish("name", …) — duplicate published var panics.
  for (const m of src.matchAll(/\bexpvar\.Publish\s*\(([^;{}]*?)\)/g)) {
    const name = firstStringLit(m[1]);
    if (name) writes.add(`expvar:${name}`);
  }

  // ── prometheus default registry — duplicate metric registration panics.
  //    (Coarse: we can't cheaply recover the metric name via regex.)
  if (/\bprometheus\.(MustRegister|Register)\s*\(/.test(src)) {
    writes.add("prometheus:default-registry");
  }

  // ── signal.Notify(ch, SIG, …) — capture each signal identifier.
  for (const m of src.matchAll(/\bsignal\.Notify\s*\(([^;{}]*?)\)/g)) {
    for (const sig of m[1].matchAll(/\b(?:syscall|os|unix)\.([A-Z][A-Za-z0-9]+)/g)) {
      listeners.add(`signal:${sig[1]}`);
    }
  }

  // ── runtime.SetFinalizer — process-wide finalizer hook (coarse).
  if (/\bruntime\.SetFinalizer\s*\(/.test(src)) {
    listeners.add("runtime:SetFinalizer");
  }

  return { writes: [...writes], listeners: [...listeners] };
}
