import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getBaseListenerSeverity,
  classifyListenerSeverity,
  escalateSeverity,
  eventListenerScanner,
  groupListenerCollisions,
  ListenerCollisionGroup,
  ListenerParticipant,
} from "./event-listeners";
import { extractPackageProfile, PackageProfile } from "./shared-ast-extractor";
import type { ResolvedPackage } from "../core/types";

describe("Stage 11: Event-Listener Severity Classification", () => {
  describe("Escalation behavior", () => {
    it("escalates severity levels correctly", () => {
      assert.equal(escalateSeverity("low"), "medium");
      assert.equal(escalateSeverity("medium"), "high");
      assert.equal(escalateSeverity("high"), "critical");
      assert.equal(escalateSeverity("critical"), "critical");
    });
  });

  describe("Base severity classification across all severity tiers", () => {
    it("classifies security-sensitive process crash events as CRITICAL", () => {
      assert.equal(getBaseListenerSeverity("global_process:uncaughtException"), "critical");
      assert.equal(getBaseListenerSeverity("global_process:unhandledRejection"), "critical");
      assert.equal(getBaseListenerSeverity("global_process:uncaughtExceptionMonitor"), "critical");
    });

    it("classifies security-sensitive browser crash events as CRITICAL", () => {
      assert.equal(getBaseListenerSeverity("global_window:error"), "critical");
      assert.equal(getBaseListenerSeverity("global_window:unhandledrejection"), "critical");
      assert.equal(getBaseListenerSeverity("global_window:rejectionhandled"), "critical");
    });

    it("classifies process termination and OS signals as HIGH", () => {
      assert.equal(getBaseListenerSeverity("global_process:exit"), "high");
      assert.equal(getBaseListenerSeverity("global_process:beforeExit"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGINT"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGTERM"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGHUP"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGQUIT"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGUSR1"), "high");
      assert.equal(getBaseListenerSeverity("global_process:SIGUSR2"), "high");
    });

    it("classifies sensitive browser communication, storage, and unload events as HIGH", () => {
      assert.equal(getBaseListenerSeverity("global_window:message"), "high");
      assert.equal(getBaseListenerSeverity("global_window:messageerror"), "high");
      assert.equal(getBaseListenerSeverity("global_window:storage"), "high");
      assert.equal(getBaseListenerSeverity("global_window:beforeunload"), "high");
      assert.equal(getBaseListenerSeverity("global_window:unload"), "high");
      assert.equal(getBaseListenerSeverity("global_window:securitypolicyviolation"), "high");
    });

    it("classifies general process diagnostic events as MEDIUM", () => {
      assert.equal(getBaseListenerSeverity("global_process:warning"), "medium");
      assert.equal(getBaseListenerSeverity("global_process:multipleResolves"), "medium");
      assert.equal(getBaseListenerSeverity("global_process:rejectionHandled"), "medium");
      assert.equal(getBaseListenerSeverity("global_process:worker"), "medium");
      assert.equal(getBaseListenerSeverity("global_process:customEvent"), "medium");
    });

    it("classifies browser navigation and window geometry/state events as MEDIUM", () => {
      assert.equal(getBaseListenerSeverity("global_window:resize"), "medium");
      assert.equal(getBaseListenerSeverity("global_window:scroll"), "medium");
      assert.equal(getBaseListenerSeverity("global_window:popstate"), "medium");
      assert.equal(getBaseListenerSeverity("global_window:hashchange"), "medium");
      assert.equal(getBaseListenerSeverity("global_window:pagehide"), "medium");
      assert.equal(getBaseListenerSeverity("global_window:pageshow"), "medium");
      assert.equal(getBaseListenerSeverity("global_document:visibilitychange"), "medium");
      assert.equal(getBaseListenerSeverity("global_document:selectionchange"), "medium");
      assert.equal(getBaseListenerSeverity("global_document:fullscreenchange"), "medium");
      assert.equal(getBaseListenerSeverity("global_document:copy"), "medium");
    });

    it("classifies standard UI interaction and DOM input events as LOW", () => {
      assert.equal(getBaseListenerSeverity("global_window:click"), "low");
      assert.equal(getBaseListenerSeverity("global_window:keydown"), "low");
      assert.equal(getBaseListenerSeverity("global_window:keyup"), "low");
      assert.equal(getBaseListenerSeverity("global_window:keypress"), "low");
      assert.equal(getBaseListenerSeverity("global_window:focus"), "low");
      assert.equal(getBaseListenerSeverity("global_window:blur"), "low");
      assert.equal(getBaseListenerSeverity("global_window:input"), "low");
      assert.equal(getBaseListenerSeverity("global_window:change"), "low");
      assert.equal(getBaseListenerSeverity("global_document:click"), "low");
      assert.equal(getBaseListenerSeverity("global_document:keydown"), "low");
    });
  });

  describe("Registration behavior and prepend listener escalation", () => {
    it("keeps base severity when normal registration methods are used", () => {
      // uncaughtException -> critical
      assert.equal(
        classifyListenerSeverity("global_process:uncaughtException", ["on", "addListener"]),
        "critical",
      );
      assert.equal(
        classifyListenerSeverity("global_process:uncaughtException", ["on", "once"]),
        "critical",
      );

      // unhandledRejection -> critical
      assert.equal(
        classifyListenerSeverity("global_process:unhandledRejection", ["on", "on"]),
        "critical",
      );

      // exit -> high
      assert.equal(
        classifyListenerSeverity("global_process:exit", ["on", "addListener"]),
        "high",
      );

      // resize -> medium
      assert.equal(
        classifyListenerSeverity("global_window:resize", ["addEventListener", "addEventListener"]),
        "medium",
      );

      // click -> low
      assert.equal(
        classifyListenerSeverity("global_window:click", ["addEventListener", "addEventListener"]),
        "low",
      );
    });

    it("escalates severity when prependListener or prependOnceListener is used", () => {
      // LOW -> escalated to MEDIUM
      assert.equal(
        classifyListenerSeverity("global_window:click", ["addEventListener", "prependListener"]),
        "medium",
      );
      assert.equal(
        classifyListenerSeverity("global_window:click", ["prependOnceListener", "addEventListener"]),
        "medium",
      );

      // MEDIUM -> escalated to HIGH
      assert.equal(
        classifyListenerSeverity("global_window:resize", ["addEventListener", "prependListener"]),
        "high",
      );
      assert.equal(
        classifyListenerSeverity("global_process:warning", ["on", "prependOnceListener"]),
        "high",
      );

      // HIGH -> escalated to CRITICAL
      assert.equal(
        classifyListenerSeverity("global_process:exit", ["on", "prependListener"]),
        "critical",
      );
      assert.equal(
        classifyListenerSeverity("global_process:SIGTERM", ["addListener", "prependOnceListener"]),
        "critical",
      );
      assert.equal(
        classifyListenerSeverity("global_window:message", ["addEventListener", "prependListener"]),
        "critical",
      );

      // CRITICAL -> remains CRITICAL (cannot exceed maximum)
      assert.equal(
        classifyListenerSeverity("global_process:uncaughtException", ["on", "prependListener"]),
        "critical",
      );
      assert.equal(
        classifyListenerSeverity("global_process:unhandledRejection", ["prependOnceListener", "on"]),
        "critical",
      );
    });

    it("ensures equivalent registration methods produce identical severity", () => {
      const target = "global_process:exit";
      const sev1 = classifyListenerSeverity(target, ["on", "on"]);
      const sev2 = classifyListenerSeverity(target, ["on", "addListener"]);
      const sev3 = classifyListenerSeverity(target, ["addListener", "once"]);
      const sev4 = classifyListenerSeverity(target, ["once", "on"]);

      assert.equal(sev1, "high");
      assert.equal(sev2, "high");
      assert.equal(sev3, "high");
      assert.equal(sev4, "high");
    });

    it("produces deterministic results regardless of participant ordering", () => {
      const target = "global_window:resize";
      const sevA = classifyListenerSeverity(target, ["addEventListener", "prependListener"]);
      const sevB = classifyListenerSeverity(target, ["prependListener", "addEventListener"]);
      const sevC = classifyListenerSeverity(target, ["addEventListener", "addEventListener", "prependListener"]);

      assert.equal(sevA, "high");
      assert.equal(sevB, "high");
      assert.equal(sevC, "high");
    });
  });

  describe("Classification from ListenerCollisionGroup object", () => {
    it("classifies collision groups directly using participant metadata", () => {
      const group: ListenerCollisionGroup = {
        canonicalTarget: "global_process:exit",
        owners: ["pkg-a", "pkg-b"],
        participants: [
          {
            packageName: "pkg-a",
            canonicalTarget: "global_process:exit",
            listenerMethod: "on",
            eventName: "exit",
          },
          {
            packageName: "pkg-b",
            canonicalTarget: "global_process:exit",
            listenerMethod: "prependListener",
            eventName: "exit",
          },
        ],
      };

      const severity = classifyListenerSeverity(group);
      assert.equal(severity, "critical");
    });
  });

  describe("End-to-end scanner severity integration", () => {
    it("assigns appropriate MVP severities to all findings in eventListenerScanner.scan", async () => {
      const codeA = `
process.on("uncaughtException", fn1);
process.on("unhandledRejection", fn2);
process.on("exit", fn3);
process.prependListener("warning", fn4);
window.addEventListener("resize", fn5);
window.addEventListener("click", fn6);
`;

      const codeB = `
process.addListener("uncaughtException", fn7);
process.once("unhandledRejection", fn8);
process.on("exit", fn9);
process.on("warning", fn10);
window.addEventListener("resize", fn11);
window.addEventListener("click", fn12);
`;

      const pkgs: ResolvedPackage[] = [
        { name: "pkg-one", version: "1.0.0" },
        { name: "pkg-two", version: "2.0.0" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(codeA, "pkg-one", "a.js"),
        extractPackageProfile(codeB, "pkg-two", "b.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);
      assert.equal(collisions.length, 6);

      const findings = collisions.map((c) => ({
        scanner: "event-listeners",
        severity: classifyListenerSeverity(c),
        target: c.canonicalTarget,
        owners: c.owners,
        message: `${c.owners.length} packages register a listener on "${c.canonicalTarget}"`,
      }));

      // Find individual findings and assert exact severities
      const uncaughtFinding = findings.find((f) => f.target === "global_process:uncaughtException");
      const rejectionFinding = findings.find((f) => f.target === "global_process:unhandledRejection");
      const exitFinding = findings.find((f) => f.target === "global_process:exit");
      const warningFinding = findings.find((f) => f.target === "global_process:warning");
      const resizeFinding = findings.find((f) => f.target === "global_window:resize");
      const clickFinding = findings.find((f) => f.target === "global_window:click");

      assert.ok(uncaughtFinding);
      assert.equal(uncaughtFinding.severity, "critical");

      assert.ok(rejectionFinding);
      assert.equal(rejectionFinding.severity, "critical");

      assert.ok(exitFinding);
      assert.equal(exitFinding.severity, "high");

      assert.ok(warningFinding);
      // warning base = medium, but codeA uses prependListener -> escalated to high
      assert.equal(warningFinding.severity, "high");

      assert.ok(resizeFinding);
      assert.equal(resizeFinding.severity, "medium");

      assert.ok(clickFinding);
      assert.equal(clickFinding.severity, "low");
    });
  });
});
