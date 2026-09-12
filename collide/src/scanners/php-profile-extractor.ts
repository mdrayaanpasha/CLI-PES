// scanners/php-profile-extractor.ts
// Extract collision-relevant targets from PHP source. Two buckets, mirroring
// the npm PackageProfile shape:
//   writes     — process-global definitions/config where two packages clash:
//                root-namespace function definitions (a redeclaration is a FATAL
//                error in PHP), define() constants, ini_set() config, $GLOBALS.
//   listeners  — process-wide handler registrations that are "last call wins":
//                error/exception handlers, shutdown functions, autoloaders,
//                pcntl signal handlers.
//
// This is a HEURISTIC pattern scan, not a real PHP AST parse (tree-sitter-php
// would be the accurate path — see docs/ecosystems/php-composer.md §2). The
// patterns below are syntactically distinctive enough to give strong signal for
// the high-value "two packages fight over one process-global" cases.
//
// Function definitions are namespace-sensitive: only ROOT-namespace functions
// collide (a `namespace Foo;` scopes them). Since a scanned blob concatenates
// many files, we reset namespace tracking at each `<?php` open tag (a new file)
// and clear it on a `namespace …` statement. The other targets are function
// CALLS, which resolve to the global function regardless of namespace, so they
// are matched over the whole blob.

import type { PackageProfile } from "./shared-ast-extractor";

/**
 * Strip `//` and `#` line comments and `/* … *\/` block comments so patterns in
 * comments don't match. String literals are intentionally KEPT — we need their
 * contents (the define()/ini_set() argument names). Coarse but adequate for a
 * heuristic pass. (mirrors the Python extractor's choice.)
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/#[^\n]*/g, " ");
}

/** First quoted string literal (single or double) inside an arg blob, or null. */
function firstStringLit(args: string): string | null {
  const m = args.match(/["']((?:[^"'\\]|\\.)*)["']/);
  return m ? m[1] : null;
}

/**
 * Extract root-namespace function definitions. Walk lines tracking the current
 * namespace: a `<?php` open tag resets to root (new file), a `namespace X;` or
 * `namespace X {` sets a non-root scope. A `function name(` seen while in the
 * root namespace, and not preceded by a method modifier (public/… ) or `->`/`::`,
 * is a global function — a redeclaration across packages is a PHP fatal error.
 */
function extractGlobalFunctions(src: string): string[] {
  const found = new Set<string>();
  let rootNs = true; // start of file, before any namespace statement

  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();

    if (line.includes("<?php")) rootNs = true; // new file boundary
    const ns = line.match(/^namespace\s+([^;{]*)/);
    if (ns) {
      // `namespace;` / `namespace {` (empty) is still the global namespace
      rootNs = ns[1].trim() === "";
      continue;
    }
    if (!rootNs) continue;

    // top-level `function name(...)`, not a class method or a call
    const fn = line.match(
      /(?:^|[^>:\w])function\s+&?\s*([a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*)\s*\(/,
    );
    if (!fn) continue;
    // skip method declarations (public/protected/private/static/abstract/final)
    if (/\b(?:public|protected|private|static|abstract|final)\s+(?:static\s+)?function\b/.test(line)) {
      continue;
    }
    found.add(`function:${fn[1]}`);
  }
  return [...found];
}

export function extractPhpProfile(source: string): PackageProfile {
  const src = stripComments(source);
  const writes = new Set<string>(extractGlobalFunctions(src));
  const listeners = new Set<string>();

  // ── define('NAME', …) / define("NAME", …) — process-global constant.
  //    Two packages defining the same constant → redefinition warning, last wins.
  for (const m of src.matchAll(/\bdefine\s*\(\s*["']([^"']+)["']/g)) {
    writes.add(`define:${m[1]}`);
  }

  // ── ini_set('option', …) — process-global runtime config.
  for (const m of src.matchAll(/\bini_set\s*\(\s*["']([^"']+)["']/g)) {
    writes.add(`ini:${m[1]}`);
  }

  // ── $GLOBALS['key'] = … — shared superglobal mutation.
  for (const m of src.matchAll(/\$GLOBALS\s*\[\s*["']([^"']+)["']\s*\]\s*=(?!=)/g)) {
    writes.add(`globals:${m[1]}`);
  }

  // ── set_error_handler(…) / set_exception_handler(…) — last registration wins.
  if (/\bset_error_handler\s*\(/.test(src)) listeners.add("error-handler:set");
  if (/\bset_exception_handler\s*\(/.test(src)) {
    listeners.add("exception-handler:set");
  }

  // ── register_shutdown_function(…) — competing shutdown hooks.
  if (/\bregister_shutdown_function\s*\(/.test(src)) {
    listeners.add("shutdown:register");
  }

  // ── spl_autoload_register(…) — competing autoloaders on the stack.
  if (/\bspl_autoload_register\s*\(/.test(src)) listeners.add("autoload:register");

  // ── pcntl_signal(SIGTERM, …) — last handler wins, order-dependent.
  for (const m of src.matchAll(/\bpcntl_signal\s*\(([^,)]*)/g)) {
    const sig = m[1].match(/\b(SIG[A-Z0-9]+)\b/);
    listeners.add(sig ? `signal:${sig[1]}` : "signal:?");
  }

  return { writes: [...writes], listeners: [...listeners] };
}
