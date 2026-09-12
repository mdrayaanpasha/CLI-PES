import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { eventListenerScanner } from "./event-listeners";
import { clearCache } from "../cache/db";
import type { Finding, ResolvedPackage } from "../core/types";

describe("Stage 13: Scanner 3 Unit and Fixture Test Suite", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-scanner3-fixtures-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createPkg(name: string, version: string, source: string): ResolvedPackage {
    const pkgDir = path.join(tmpDir, name.replace(/[^a-zA-Z0-9_-]/g, "_"));
    fs.mkdirSync(pkgDir, { recursive: true });
    const filePath = path.join(pkgDir, "index.js");
    fs.writeFileSync(filePath, source, "utf-8");
    return {
      name,
      version,
      sourcePath: filePath,
    };
  }

  describe("Positive Fixtures — Cross-Package Collisions", () => {
    it("detects CRITICAL collision for global process uncaughtException across aliases", async () => {
      const pkg1 = createPkg(
        "error-tracker",
        "1.0.0",
        `process.on("uncaughtException", (err) => console.error(err));`,
      );
      const pkg2 = createPkg(
        "crash-reporter",
        "2.3.0",
        `
const p = process;
p.addListener('uncaughtException', (err) => sendTelemetry(err));
`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      assert.equal(f.scanner, "event-listeners");
      assert.equal(f.severity, "critical");
      assert.equal(f.target, "global_process:uncaughtException");
      assert.deepEqual(f.owners, ["crash-reporter", "error-tracker"]);
      assert.ok(f.message.includes("2 packages (crash-reporter, error-tracker)"));
      assert.ok(f.message.includes("uncaught exception handlers"));
      assert.ok(f.message.includes("error-tracker@1.0.0"));
      assert.ok(f.message.includes("crash-reporter@2.3.0"));
    });

    it("detects CRITICAL collision for global process unhandledRejection across ESM and CJS imports", async () => {
      const pkg1 = createPkg(
        "async-tracer",
        "1.1.0",
        `
import proc from 'node:process';
proc.once("unhandledRejection", (reason) => log(reason));
`,
      );
      const pkg2 = createPkg(
        "rejection-handler",
        "3.0.0",
        `
const pr = require("process");
pr.on("unhandledRejection", (reason) => handle(reason));
`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      assert.equal(f.severity, "critical");
      assert.equal(f.target, "global_process:unhandledRejection");
      assert.deepEqual(f.owners, ["async-tracer", "rejection-handler"]);
      assert.ok(f.message.includes("unhandled rejection handlers"));
    });

    it("detects process signal collision with prependListener escalating severity to CRITICAL", async () => {
      const pkg1 = createPkg(
        "signal-interceptor",
        "1.0.0",
        `process.prependListener("SIGINT", () => cleanup());`,
      );
      const pkg2 = createPkg(
        "signal-logger",
        "1.2.0",
        `process.on("SIGINT", () => console.log("interrupted"));`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      // SIGINT base is HIGH, but prependListener escalates to CRITICAL
      assert.equal(f.severity, "critical");
      assert.equal(f.target, "global_process:SIGINT");
      assert.deepEqual(f.owners, ["signal-interceptor", "signal-logger"]);
      assert.ok(f.message.includes("Prepend registration is used"));
    });

    it("detects HIGH severity collision for global_window:message cross-frame listener", async () => {
      const pkg1 = createPkg(
        "frame-bridge-a",
        "1.0.0",
        `window.addEventListener("message", (e) => handleMessage(e));`,
      );
      const pkg2 = createPkg(
        "frame-bridge-b",
        "2.0.0",
        `globalThis.window.addEventListener('message', (e) => onMsg(e));`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      assert.equal(f.severity, "high");
      assert.equal(f.target, "global_window:message");
      assert.deepEqual(f.owners, ["frame-bridge-a", "frame-bridge-b"]);
      assert.ok(f.message.includes("window message listeners"));
    });

    it("detects multi-package MEDIUM severity collision on global_window:resize", async () => {
      const pkg1 = createPkg(
        "chart-renderer",
        "1.0.0",
        `window.addEventListener("resize", () => updateChart());`,
      );
      const pkg2 = createPkg(
        "grid-layout",
        "2.0.0",
        `const win = window; win.addEventListener("resize", () => recalculateGrid());`,
      );
      const pkg3 = createPkg(
        "nav-bar",
        "3.1.0",
        `globalThis.addEventListener("resize", () => collapseNav());`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2, pkg3]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      assert.equal(f.severity, "medium");
      assert.equal(f.target, "global_window:resize");
      assert.deepEqual(f.owners, ["chart-renderer", "grid-layout", "nav-bar"]);
      assert.ok(f.message.startsWith("3 packages (chart-renderer, grid-layout, nav-bar)"));
      assert.ok(f.message.includes("viewport listeners"));
    });

    it("canonicalizes equivalent static event name representations across packages", async () => {
      const pkg1 = createPkg("pkg-quotes", "1.0.0", `process.on("exit", () => {});`);
      const pkg2 = createPkg("pkg-template", "1.0.0", `process.on(\`exit\`, () => {});`);
      const pkg3 = createPkg("pkg-concat", "1.0.0", `process.on("ex" + "it", () => {});`);

      const findings = await eventListenerScanner.scan([pkg1, pkg2, pkg3]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      assert.equal(f.severity, "high");
      assert.equal(f.target, "global_process:exit");
      assert.deepEqual(f.owners, ["pkg-concat", "pkg-quotes", "pkg-template"]);
    });

    it("escalates LOW severity to MEDIUM when prependListener is used on UI event", async () => {
      const pkg1 = createPkg(
        "click-tracker",
        "1.0.0",
        `window.addEventListener("click", () => track());`,
      );
      const pkg2 = createPkg(
        "modal-manager",
        "2.0.0",
        `window.prependListener("click", () => closeModal());`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);

      assert.equal(findings.length, 1);
      const f = findings[0];
      // click base is LOW, prependListener escalates to MEDIUM
      assert.equal(f.severity, "medium");
      assert.equal(f.target, "global_window:click");
      assert.deepEqual(f.owners, ["click-tracker", "modal-manager"]);
      assert.ok(f.message.includes("Prepend registration is used"));
    });
  });

  describe("Negative Fixtures — No False Positives", () => {
    it("produces ZERO findings for local and custom EventEmitter instances", async () => {
      const pkg1 = createPkg(
        "custom-emitter-a",
        "1.0.0",
        `
const EventEmitter = require("events");
const server = new EventEmitter();
server.on("uncaughtException", () => {});
server.on("exit", () => {});
`,
      );
      const pkg2 = createPkg(
        "custom-emitter-b",
        "1.0.0",
        `
const socket = createSocket();
socket.on("uncaughtException", () => {});
socket.on("exit", () => {});
`,
      );
      const pkg3 = createPkg(
        "shadowed-process",
        "1.0.0",
        `
function run(process) {
  process.on("uncaughtException", () => {});
}
`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2, pkg3]);
      assert.equal(findings.length, 0);
    });

    it("produces ZERO findings for same-package multiple listener registrations", async () => {
      const pkgSolo = createPkg(
        "solo-package",
        "1.0.0",
        `
process.on("exit", () => {});
process.once("exit", () => {});
process.addListener("exit", () => {});
process.prependListener("exit", () => {});
window.addEventListener("resize", () => {});
window.addEventListener("resize", () => {});
`,
      );

      const findings = await eventListenerScanner.scan([pkgSolo]);
      assert.equal(findings.length, 0);
    });

    it("produces ZERO findings for benign lifecycle listeners (DOMContentLoaded, load, readystatechange)", async () => {
      const pkg1 = createPkg(
        "dom-init-1",
        "1.0.0",
        `document.addEventListener("DOMContentLoaded", () => init());`,
      );
      const pkg2 = createPkg(
        "dom-init-2",
        "1.0.0",
        `window.addEventListener("DOMContentLoaded", () => start());`,
      );
      const pkg3 = createPkg(
        "window-loader-1",
        "1.0.0",
        `window.addEventListener("load", () => onLoad());`,
      );
      const pkg4 = createPkg(
        "window-loader-2",
        "1.0.0",
        `document.addEventListener("load", () => onLoad());`,
      );
      const pkg5 = createPkg(
        "state-tracker",
        "1.0.0",
        `document.addEventListener("readystatechange", () => onReady());`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2, pkg3, pkg4, pkg5]);
      assert.equal(findings.length, 0);
    });

    it("produces ZERO findings for dynamic or non-statically-analyzable event names", async () => {
      const pkg1 = createPkg(
        "dyn-event-1",
        "1.0.0",
        `process.on(getEventName(), () => {});`,
      );
      const pkg2 = createPkg(
        "dyn-event-2",
        "1.0.0",
        `
const EVENT = config.event;
process.on(EVENT, () => {});
`,
      );
      const pkg3 = createPkg(
        "dyn-event-3",
        "1.0.0",
        `window.addEventListener(window.eventName, () => {});`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2, pkg3]);
      assert.equal(findings.length, 0);
    });

    it("produces ZERO findings for individual DOM element event listeners", async () => {
      const pkg1 = createPkg(
        "button-a",
        "1.0.0",
        `
const btn = document.getElementById("submit");
btn.addEventListener("click", () => submit());
`,
      );
      const pkg2 = createPkg(
        "button-b",
        "1.0.0",
        `
const btn = document.querySelector("#submit");
btn.addEventListener("click", () => submit());
`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);
      assert.equal(findings.length, 0);
    });

    it("produces ZERO findings for unrelated method calls and non-listener calls", async () => {
      const pkg1 = createPkg(
        "unrelated-1",
        "1.0.0",
        `
emitter.emit("exit");
emitter.off("exit", fn);
emitter.removeAllListeners("exit");
`,
      );
      const pkg2 = createPkg(
        "unrelated-2",
        "1.0.0",
        `
logger.info("exit");
process.exit(0);
window.focus();
`,
      );

      const findings = await eventListenerScanner.scan([pkg1, pkg2]);
      assert.equal(findings.length, 0);
    });
  });

  describe("Complex Multi-Package Mixed Workload", () => {
    it("correctly separates multiple collisions from benign/local listeners in a complex dependency tree", async () => {
      // Pkg A: registers uncaughtException, resize, local server, and DOMContentLoaded
      const pkgA = createPkg(
        "pkg-a",
        "1.0.0",
        `
process.on("uncaughtException", handleUncaught);
window.addEventListener("resize", handleResize);
document.addEventListener("DOMContentLoaded", handleReady);
const server = createServer();
server.on("request", handleReq);
`,
      );

      // Pkg B: registers uncaughtException (prepend), resize, local socket
      const pkgB = createPkg(
        "pkg-b",
        "2.0.0",
        `
process.prependListener("uncaughtException", handleUncaughtPrepend);
window.addEventListener("resize", handleResizeB);
const socket = createSocket();
socket.on("request", handleReqB);
`,
      );

      // Pkg C: registers SIGTERM, warning (once), benign load
      const pkgC = createPkg(
        "pkg-c",
        "1.5.0",
        `
process.on("SIGTERM", handleSigTerm);
process.once("warning", handleWarn);
window.addEventListener("load", handleLoad);
`,
      );

      // Pkg D: registers SIGTERM (addListener), warning (on)
      const pkgD = createPkg(
        "pkg-d",
        "3.0.0",
        `
process.addListener("SIGTERM", handleSigTermD);
process.on("warning", handleWarnD);
`,
      );

      const findings = await eventListenerScanner.scan([pkgA, pkgB, pkgC, pkgD]);

      // Collisions expected:
      // 1. global_process:uncaughtException (pkg-a, pkg-b) -> CRITICAL
      // 2. global_process:SIGTERM (pkg-c, pkg-d) -> HIGH
      // 3. global_process:warning (pkg-c, pkg-d) -> MEDIUM
      // 4. global_window:resize (pkg-a, pkg-b) -> MEDIUM
      // (DOMContentLoaded, load, and local emitters server/socket must be filtered out)

      assert.equal(findings.length, 4);

      const targets = findings.map((f) => f.target).sort();
      assert.deepEqual(targets, [
        "global_process:SIGTERM",
        "global_process:uncaughtException",
        "global_process:warning",
        "global_window:resize",
      ]);

      const uncaughtF = findings.find((f) => f.target === "global_process:uncaughtException")!;
      assert.equal(uncaughtF.severity, "critical");
      assert.deepEqual(uncaughtF.owners, ["pkg-a", "pkg-b"]);

      const sigF = findings.find((f) => f.target === "global_process:SIGTERM")!;
      assert.equal(sigF.severity, "high");
      assert.deepEqual(sigF.owners, ["pkg-c", "pkg-d"]);

      const warnF = findings.find((f) => f.target === "global_process:warning")!;
      assert.equal(warnF.severity, "medium");
      assert.deepEqual(warnF.owners, ["pkg-c", "pkg-d"]);

      const resizeF = findings.find((f) => f.target === "global_window:resize")!;
      assert.equal(resizeF.severity, "medium");
      assert.deepEqual(resizeF.owners, ["pkg-a", "pkg-b"]);
    });
  });
});
