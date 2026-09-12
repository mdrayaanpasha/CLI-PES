// scanners/py-profile-extractor.ts
// Extract collision-relevant targets from Python source. Two buckets, mirroring
// the npm PackageProfile shape:
//   writes     — shared mutable global / builtin state that "last import wins"
//   listeners  — process-wide handler registrations (signal/atexit/excepthook)
//
// This is a HEURISTIC pattern scan, not a real Python AST parse. Python's `ast`
// module runs in Python, not Node (see docs/ecosystems/python-pip.md §3). The
// patterns below are syntactically distinctive enough that regex extraction
// gives strong signal for the high-value "two packages fight over one global"
// cases: signal handlers, atexit hooks, sys.excepthook, monkeypatched stdlib,
// sys.modules surgery, os.environ writes, and gevent/eventlet monkeypatching.

import type { PackageProfile } from "./shared-ast-extractor";

/** Strip `#` line comments and triple-quoted string blocks to avoid matches in
 *  docstrings/comments. Coarse but adequate for a heuristic pass. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/'''[\s\S]*?'''/g, " ")
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/#[^\n]*/g, " ");
}

/** First quoted string literal (single or double) inside an arg blob, or null. */
function firstStringLit(args: string): string | null {
  const m = args.match(/["']((?:[^"'\\]|\\.)*)["']/);
  return m ? m[1] : null;
}

export function extractPyProfile(source: string): PackageProfile {
  const src = stripCommentsAndStrings(source);
  const writes = new Set<string>();
  const listeners = new Set<string>();

  // ── signal.signal(signal.SIGTERM, …) — last handler wins, order-dependent.
  for (const m of src.matchAll(/\bsignal\.signal\s*\(([^)]*)\)/g)) {
    const sig = m[1].match(/\bsignal\.([A-Z][A-Z0-9_]+)/);
    listeners.add(sig ? `signal:${sig[1]}` : "signal:?");
  }

  // ── atexit.register(fn) — competing shutdown hooks.
  if (/\batexit\.register\s*\(/.test(src)) {
    listeners.add("atexit:register");
  }

  // ── sys.excepthook / sys.unraisablehook / threading.excepthook assignment.
  for (const m of src.matchAll(
    /\b(sys|threading)\.(excepthook|unraisablehook)\s*=/g,
  )) {
    listeners.add(`excepthook:${m[1]}.${m[2]}`);
  }

  // ── sys.addaudithook(...) — process-wide audit hook.
  if (/\bsys\.addaudithook\s*\(/.test(src)) {
    listeners.add("audithook:sys.addaudithook");
  }

  // ── import hooks: sys.meta_path / sys.path_hooks mutation.
  for (const m of src.matchAll(
    /\bsys\.(meta_path|path_hooks)\s*\.\s*(?:append|insert|extend)\s*\(/g,
  )) {
    listeners.add(`import-hook:sys.${m[1]}`);
  }

  // ── os.environ["KEY"] = … — process-global config write.
  for (const m of src.matchAll(
    /\bos\.environ\s*\[\s*["']([^"']+)["']\s*\]\s*=/g,
  )) {
    writes.add(`environ:${m[1]}`);
  }
  // os.environ["KEY"] = via .setdefault / .update patterns
  for (const m of src.matchAll(
    /\bos\.environ\.setdefault\s*\(\s*["']([^"']+)["']/g,
  )) {
    writes.add(`environ:${m[1]}`);
  }

  // ── sys.modules["json"] = ujson — swaps a module for the whole process.
  for (const m of src.matchAll(/\bsys\.modules\s*\[\s*["']([^"']+)["']\s*\]\s*=/g)) {
    writes.add(`sys-modules:${m[1]}`);
  }

  // ── gevent/eventlet monkeypatching — rewrites stdlib for everyone.
  if (/\bgevent\.monkey\.patch_all\s*\(/.test(src) || /\bmonkey\.patch_all\s*\(/.test(src)) {
    writes.add("monkeypatch:gevent.patch_all");
  }
  if (/\beventlet\.monkey_patch\s*\(/.test(src)) {
    writes.add("monkeypatch:eventlet.monkey_patch");
  }

  // ── warnings.filterwarnings(...) / simplefilter(...) — shared filter stack.
  for (const m of src.matchAll(
    /\bwarnings\.(filterwarnings|simplefilter)\s*\(([^)]*)\)/g,
  )) {
    const action = firstStringLit(m[2]);
    writes.add(action ? `warnings:${action}` : `warnings:${m[1]}`);
  }

  // ── monkeypatch of a stdlib callable: `socket.socket = MyPatched`,
  //    `json.dumps = ...`. Match `<module>.<attr> = ` where module is a known
  //    stdlib module — assignment to an imported module's attribute rewrites it
  //    process-wide. Coarse but distinctive.
  const STDLIB = [
    "socket",
    "ssl",
    "json",
    "time",
    "threading",
    "subprocess",
    "os",
    "asyncio",
    "select",
    "http",
  ];
  const patchRe = new RegExp(
    `\\b(${STDLIB.join("|")})\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=(?!=)`,
    "g",
  );
  for (const m of src.matchAll(patchRe)) {
    // skip os.environ[...] (handled above) — that's an index, not attr assign
    writes.add(`monkeypatch:${m[1]}.${m[2]}`);
  }

  return { writes: [...writes], listeners: [...listeners] };
}
