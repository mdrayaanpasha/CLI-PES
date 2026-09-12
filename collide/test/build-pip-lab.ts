// test/build-pip-lab.ts
// Builds a deterministic synthetic Python (pip) project engineered to trip every
// Python scanner at once. See docs/ecosystems/python-pip.md §5.
//
//   • osv              — real package names pinned at known-vulnerable releases
//                        (Django==2.2.0, requests==2.19.1, PyYAML==5.1,
//                        Jinja2==2.10 — all have well-known CVEs on OSV).
//   • version-conflict — the same package emitted twice at different versions
//                        (jinja2 2.10 and 3.0.0) inside the lockfile.
//   • global-state     — two synthetic packages that both monkeypatch
//                        socket.socket and both write os.environ["TZ"].
//   • event-listeners  — two synthetic packages that both signal.signal(SIGTERM)
//                        and both atexit.register(...).
//
// OSV needs only name@version (it queries osv.dev over the network). The
// collision packages carry real .py source in a synthetic venv site-packages so
// the heuristic source scanners resolve them.
//
// NOTE: the `osv` scanner requires network access to return findings; the
// version-conflict and collision scanners are fully offline and deterministic.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PipLabPackage {
  /** distribution name (as it appears in the lockfile) */
  name: string;
  /** exact version */
  version: string;
  /** why it's in the lab (dev reference) */
  note?: string;
  /** synthetic .py source written into the fake site-packages; drives the
   *  global-state / event-listeners scanners. Keyed by relative file path. */
  source?: Record<string, string>;
}

export const PIP_LAB_PACKAGES: PipLabPackage[] = [
  // ── real, known-vulnerable (OSV) ──
  { name: "Django", version: "2.2.0", note: "multiple Django CVEs" },
  { name: "requests", version: "2.19.1", note: "CVE in older requests" },
  { name: "PyYAML", version: "5.1", note: "arbitrary code execution CVE" },
  { name: "Jinja2", version: "2.10", note: "ReDoS / sandbox CVEs" },

  // ── version-conflict: jinja2 present twice at different versions ──
  //    (2.10 above normalizes to `jinja2`; add a second pin at 3.0.0)
  { name: "jinja2", version: "3.0.0", note: "duplicate of Jinja2 → version conflict" },

  // ── clean dep — single version, must NOT be flagged ──
  { name: "certifi", version: "2023.7.22", note: "clean dep" },

  // ── collision fixtures — carry real Python source in the fake venv ──
  // Designed overlaps:
  //   monkeypatch:socket.socket → alpha + beta   (global-state)
  //   environ:TZ                → alpha + beta   (global-state)
  //   signal:SIGTERM            → alpha + beta   (event-listeners)
  //   atexit:register           → alpha + beta   (event-listeners)
  {
    name: "collide-alpha",
    version: "1.0.0",
    note: "collides on socket monkeypatch, TZ, SIGTERM, atexit",
    source: {
      "collide_alpha/__init__.py": `import os
import signal
import socket
import atexit


class _PatchedSocket(socket.socket):
    pass


socket.socket = _PatchedSocket
os.environ["TZ"] = "UTC"


def _handler(signum, frame):
    pass


signal.signal(signal.SIGTERM, _handler)
atexit.register(lambda: None)
`,
    },
  },
  {
    name: "collide-beta",
    version: "0.9.0",
    note: "collides on socket monkeypatch, TZ, SIGTERM, atexit",
    source: {
      "collide_beta/__init__.py": `import os
import signal
import socket
import atexit


def _my_socket(*args, **kwargs):
    return None


socket.socket = _my_socket
os.environ["TZ"] = "America/New_York"


def _shutdown(signum, frame):
    pass


signal.signal(signal.SIGTERM, _shutdown)
atexit.register(_shutdown)
`,
    },
  },
];

const PY_VERSION = "python3.11";

/**
 * Render a `requirements.txt` from the lab packages, plus a couple of unpinned /
 * skippable rows so the parser's skip-counting is exercised.
 */
function renderRequirements(pkgs: PipLabPackage[]): string {
  const lines = pkgs.map((p) => `${p.name}==${p.version}`);
  lines.push("# an unpinned row that must be skipped:");
  lines.push("flask>=2.0");
  lines.push("-e ./local-editable");
  lines.push("");
  return lines.join("\n");
}

/** Where the fake venv site-packages lives for a given lab root. */
export function sitePackagesPath(root: string): string {
  return join(root, ".venv", "lib", PY_VERSION, "site-packages");
}

/**
 * Materialize the fake venv site-packages, writing each collision package's
 * synthetic source. Packages without `source` contribute nothing (manifest-only,
 * like the real vuln packages).
 */
export function buildSitePackages(root: string): string {
  const sp = sitePackagesPath(root);
  for (const p of PIP_LAB_PACKAGES) {
    if (!p.source) continue;
    for (const [file, contents] of Object.entries(p.source)) {
      const full = join(sp, file);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    }
  }
  return sp;
}

/**
 * Materialize the pip lab into `root`. Returns the path to requirements.txt; a
 * fake venv (`root/.venv/.../site-packages`) is written alongside so the source
 * scanners resolve the collision packages. Idempotent: wipes `root` first.
 */
export function buildPipLab(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const reqPath = join(root, "requirements.txt");
  writeFileSync(reqPath, renderRequirements(PIP_LAB_PACKAGES));
  buildSitePackages(root);
  return reqPath;
}

// Allow running standalone: `tsx test/build-pip-lab.ts <dir>` to inspect it.
if (process.argv[1] && process.argv[1].endsWith("build-pip-lab.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".pip-lab");
  const p = buildPipLab(dir);
  console.log("pip-lab built at", dir);
  console.log("requirements.txt:", p);
  console.log(
    "\nexpect: osv (Django, requests, PyYAML, Jinja2) · " +
      "version-conflict (jinja2 2.10/3.0.0) · " +
      "global-state (socket.socket, environ:TZ) · " +
      "event-listeners (signal:SIGTERM, atexit:register)",
  );
}
