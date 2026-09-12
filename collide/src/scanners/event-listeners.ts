// scanners/event-listeners.ts
// Scan 3: same profiles as global-state, different bucket (listeners).

import type { Finding, ResolvedPackage, Scanner, Severity } from "../core/types";
import { getOrCache } from "../cache/db";
import {
  extractPackageProfile,
  ListenerRegistration,
  PackageProfile,
} from "./shared-ast-extractor";
import { groupByTarget } from "./util";

/**
 * Canonicalizes a ListenerRegistration into a single deterministic collision key.
 * e.g. "global_process:uncaughtException" or "global_window:resize".
 */
export function getCanonicalListenerKey(listener: ListenerRegistration): string {
  if (listener.receiverScope === "global") {
    if (
      listener.targetIdentity.name === "process" ||
      (listener.targetIdentity.type === "emitter" && listener.targetIdentity.name === "process")
    ) {
      return `global_process:${listener.eventName}`;
    }
    if (listener.targetIdentity.type === "window") {
      return `global_window:${listener.eventName}`;
    }
    if (listener.targetIdentity.type === "document") {
      return `global_document:${listener.eventName}`;
    }
    if (listener.targetIdentity.name === "globalThis") {
      return `global_globalThis:${listener.eventName}`;
    }
    return `global_${listener.targetIdentity.type}:${listener.eventName}`;
  }

  if (listener.receiverScope === "dom") {
    const name = listener.targetIdentity.name ? `:${listener.targetIdentity.name}` : "";
    return `dom_${listener.targetIdentity.type}${name}:${listener.eventName}`;
  }

  if (listener.receiverScope === "module") {
    const name = listener.targetIdentity.name ? `:${listener.targetIdentity.name}` : "";
    return `module_${listener.targetIdentity.type}${name}:${listener.eventName}`;
  }

  const targetName = listener.targetIdentity.name
    ? `${listener.targetIdentity.type}:${listener.targetIdentity.name}`
    : listener.targetIdentity.type;
  return `${targetName}:${listener.eventName}`;
}

export const getListenerId = getCanonicalListenerKey;

export const BENIGN_LIFECYCLE_TARGETS = new Set([
  "global_document:DOMContentLoaded",
  "global_window:DOMContentLoaded",
  "global_document:load",
  "global_window:load",
  "global_document:readystatechange",
  "global_window:readystatechange",
]);

/**
 * Checks if a target represents a benign lifecycle listener excluded from collision reporting.
 */
export function isBenignLifecycleTarget(
  canonicalTarget: string,
  eventName?: string,
): boolean {
  if (BENIGN_LIFECYCLE_TARGETS.has(canonicalTarget)) {
    return true;
  }
  if (
    (canonicalTarget.startsWith("global_window:") ||
      canonicalTarget.startsWith("global_document:")) &&
    (eventName === "DOMContentLoaded" ||
      eventName === "load" ||
      eventName === "readystatechange")
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether a listener registration is eligible for cross-package collision analysis.
 * Filters out:
 * - Local / non-global scopes (module, dom, unknown)
 * - Dynamic / unknown event names ("<unknown>")
 * - Benign lifecycle events (e.g. DOMContentLoaded, load, readystatechange)
 */
export function isEligibleCollisionListener(listener: ListenerRegistration): boolean {
  // 1. Must be a shared global receiver scope (filters out local/module and dom elements)
  if (listener.receiverScope !== "global") {
    return false;
  }

  // 2. Must have a statically determinable, non-empty event name
  if (!listener.eventName || listener.eventName === "<unknown>") {
    return false;
  }

  // 3. Must not be an excluded benign lifecycle event
  const canonicalKey = getCanonicalListenerKey(listener);
  if (isBenignLifecycleTarget(canonicalKey, listener.eventName)) {
    return false;
  }

  return true;
}

export interface ListenerParticipant {
  packageName: string;
  packageVersion?: string;
  canonicalTarget: string;
  listenerMethod: string;
  eventName: string;
  sourceLocation?: { line: number; column: number };
  moduleContext?: string;
}

export interface ListenerCollisionGroup {
  canonicalTarget: string;
  owners: string[];
  participants: ListenerParticipant[];
}

/**
 * Groups listener profiles across packages by their canonical target,
 * applying false-positive filtering, tracking participant metadata,
 * and filtering only cross-package collisions (2+ distinct packages).
 */
export function groupListenerCollisions(
  pkgs: ResolvedPackage[],
  profiles: PackageProfile[],
): ListenerCollisionGroup[] {
  const groupsMap = new Map<
    string,
    { ownersSet: Set<string>; participants: ListenerParticipant[] }
  >();

  profiles.forEach((profile, i) => {
    const pkg = pkgs[i];
    const ownerName = pkg.name;

    for (const listener of profile.listeners) {
      // Apply MVP False-Positive Filtering:
      // Filter out non-globals, dynamic/unknown event names, and benign lifecycle events
      if (!isEligibleCollisionListener(listener)) {
        continue;
      }

      const canonicalTarget = getCanonicalListenerKey(listener);

      let group = groupsMap.get(canonicalTarget);
      if (!group) {
        group = { ownersSet: new Set(), participants: [] };
        groupsMap.set(canonicalTarget, group);
      }

      group.ownersSet.add(ownerName);
      group.participants.push({
        packageName: ownerName,
        packageVersion: pkg.version,
        canonicalTarget,
        listenerMethod: listener.listenerMethod,
        eventName: listener.eventName,
        sourceLocation: listener.sourceLocation,
        moduleContext: listener.moduleContext || pkg.sourcePath,
      });
    }
  });

  const collisions: ListenerCollisionGroup[] = [];

  for (const [canonicalTarget, { ownersSet, participants }] of groupsMap.entries()) {
    // Cross-package collision invariant: must have 2+ distinct package owners
    if (ownersSet.size >= 2) {
      collisions.push({
        canonicalTarget,
        owners: [...ownersSet].sort(),
        participants,
      });
    }
  }

  // Deterministic sorting of collision groups by canonical target
  collisions.sort((a, b) => a.canonicalTarget.localeCompare(b.canonicalTarget));

  return collisions;
}

/**
 * Escalates a severity level by one step (due to prepend listener registration).
 */
export function escalateSeverity(severity: Severity): Severity {
  switch (severity) {
    case "low":
      return "medium";
    case "medium":
      return "high";
    case "high":
    case "critical":
      return "critical";
  }
}

/**
 * Determines the base severity of a canonical listener collision target
 * before accounting for registration method behavior (e.g. prepending).
 */
export function getBaseListenerSeverity(canonicalTarget: string): Severity {
  const colonIndex = canonicalTarget.indexOf(":");
  if (colonIndex === -1) {
    return "low";
  }

  const receiver = canonicalTarget.substring(0, colonIndex);
  const eventName = canonicalTarget.substring(colonIndex + 1);

  if (receiver === "global_process") {
    // Process crash and unhandled exception handlers -> CRITICAL
    if (
      eventName === "uncaughtException" ||
      eventName === "unhandledRejection" ||
      eventName === "uncaughtExceptionMonitor"
    ) {
      return "critical";
    }

    // Process termination and OS signal handlers -> HIGH
    if (
      eventName === "exit" ||
      eventName === "beforeExit" ||
      eventName.startsWith("SIG")
    ) {
      return "high";
    }

    // General diagnostic and process events -> MEDIUM
    return "medium";
  }

  if (
    receiver === "global_window" ||
    receiver === "global_document" ||
    receiver === "global_globalThis"
  ) {
    // Unhandled browser errors/rejections -> CRITICAL
    if (
      eventName === "error" ||
      eventName === "unhandledrejection" ||
      eventName === "rejectionhandled"
    ) {
      return "critical";
    }

    // Sensitive communication/storage/lifecycle events -> HIGH
    if (
      eventName === "message" ||
      eventName === "messageerror" ||
      eventName === "storage" ||
      eventName === "beforeunload" ||
      eventName === "unload" ||
      eventName === "securitypolicyviolation"
    ) {
      return "high";
    }

    // Navigation and geometry/window state events -> MEDIUM
    if (
      eventName === "resize" ||
      eventName === "scroll" ||
      eventName === "popstate" ||
      eventName === "hashchange" ||
      eventName === "pagehide" ||
      eventName === "pageshow" ||
      eventName === "visibilitychange" ||
      eventName === "selectionchange" ||
      eventName === "fullscreenchange" ||
      eventName === "fullscreenerror" ||
      eventName === "copy" ||
      eventName === "cut" ||
      eventName === "paste"
    ) {
      return "medium";
    }

    // Low-risk standard UI interaction events -> LOW
    return "low";
  }

  return "low";
}

/**
 * Classifies the final MVP severity of a listener collision.
 * Evaluates the canonical target and checks if any participant uses
 * prependListener / prependOnceListener to escalate severity.
 */
export function classifyListenerSeverity(
  targetOrGroup: string | ListenerCollisionGroup,
  participantsOrMethods?: (ListenerParticipant | string)[],
): Severity {
  let canonicalTarget: string;
  let methods: string[] = [];

  if (typeof targetOrGroup === "object" && targetOrGroup !== null) {
    canonicalTarget = targetOrGroup.canonicalTarget;
    if (Array.isArray(targetOrGroup.participants)) {
      methods = targetOrGroup.participants.map((p) => p.listenerMethod);
    }
  } else {
    canonicalTarget = targetOrGroup;
    if (Array.isArray(participantsOrMethods)) {
      methods = participantsOrMethods.map((item) =>
        typeof item === "string" ? item : item.listenerMethod,
      );
    }
  }

  const baseSeverity = getBaseListenerSeverity(canonicalTarget);

  const hasPrepend = methods.some(
    (m) => m === "prependListener" || m === "prependOnceListener",
  );

  return hasPrepend ? escalateSeverity(baseSeverity) : baseSeverity;
}

/**
 * Generates an explainable risk rationale explaining why the collision matters.
 */
export function getCollisionRiskRationale(
  canonicalTarget: string,
  hasPrepend = false,
): string {
  const colonIndex = canonicalTarget.indexOf(":");
  const receiver = colonIndex !== -1 ? canonicalTarget.substring(0, colonIndex) : "";
  const eventName = colonIndex !== -1 ? canonicalTarget.substring(colonIndex + 1) : canonicalTarget;

  let rationale = "";

  if (receiver === "global_process") {
    if (eventName === "uncaughtException" || eventName === "uncaughtExceptionMonitor") {
      rationale =
        "Competing uncaught exception handlers can swallow unhandled errors, cause duplicate crash reporting, or prevent graceful process termination.";
    } else if (eventName === "unhandledRejection") {
      rationale =
        "Multiple unhandled rejection handlers can interfere with promise error tracking or lead to uncoordinated process exits.";
    } else if (eventName === "exit" || eventName === "beforeExit") {
      rationale =
        "Multiple process exit handlers can cause race conditions during teardown or fail to complete asynchronous cleanup before termination.";
    } else if (eventName.startsWith("SIG")) {
      rationale =
        "Multiple OS signal listeners can lead to conflicting signal handling, duplicate shutdown routines, or unexpected process termination.";
    } else if (eventName === "warning") {
      rationale =
        "Multiple warning listeners can result in duplicate logging or swallowed process diagnostic warnings.";
    } else {
      rationale =
        `Multiple packages registering listeners on process "${eventName}" can conflict in event handling or state management.`;
    }
  } else if (
    receiver === "global_window" ||
    receiver === "global_document" ||
    receiver === "global_globalThis"
  ) {
    if (eventName === "error" || eventName === "unhandledrejection" || eventName === "rejectionhandled") {
      rationale =
        "Multiple global error handlers can swallow errors or result in duplicate error monitoring telemetry.";
    } else if (eventName === "message" || eventName === "messageerror") {
      rationale =
        "Concurrent window message listeners can intercept cross-frame/worker messages or cause conflicting message handling.";
    } else if (eventName === "storage") {
      rationale =
        "Concurrent storage event listeners across packages can cause duplicate state updates or synchronization conflicts.";
    } else if (eventName === "beforeunload" || eventName === "unload") {
      rationale =
        "Multiple page unload listeners can delay navigation, leak memory, or conflict during page teardown.";
    } else if (eventName === "resize" || eventName === "scroll") {
      rationale =
        "Multiple uncoordinated window viewport listeners can cause performance degradation or layout recalculation thrashing.";
    } else if (eventName === "popstate" || eventName === "hashchange") {
      rationale =
        "Multiple global navigation listeners can cause conflicting routing transitions or inconsistent history state.";
    } else if (eventName === "visibilitychange" || eventName === "selectionchange") {
      rationale =
        "Multiple global document state listeners can cause race conditions in tab activity or selection handling.";
    } else {
      rationale =
        `Multiple packages registering global listeners on "${eventName}" can cause conflicting event handling or unexpected event propagation side-effects.`;
    }
  } else {
    rationale =
      `Multiple packages registering listeners on "${canonicalTarget}" can interfere with shared resource event handling.`;
  }

  if (hasPrepend) {
    rationale +=
      " Prepend registration is used, attempting to hijack execution order ahead of other registered handlers.";
  }

  return rationale;
}

/**
 * Formats a concise, human-readable finding explanation including participant metadata
 * and risk rationale without leaking internal AST details.
 */
export function formatFindingMessage(group: ListenerCollisionGroup): string {
  const ownersList = group.owners.join(", ");
  const count = group.owners.length;
  const packageLabel = count === 1 ? "1 package" : `${count} packages`;

  const hasPrepend = (group.participants || []).some(
    (p) => p.listenerMethod === "prependListener" || p.listenerMethod === "prependOnceListener",
  );

  const rationale = getCollisionRiskRationale(group.canonicalTarget, hasPrepend);

  // Build participant details if available
  const participantDetails = (group.participants || [])
    .slice()
    .sort((a, b) => {
      const pkgCmp = a.packageName.localeCompare(b.packageName);
      if (pkgCmp !== 0) return pkgCmp;
      const modA = a.moduleContext || "";
      const modB = b.moduleContext || "";
      const modCmp = modA.localeCompare(modB);
      if (modCmp !== 0) return modCmp;
      return (a.sourceLocation?.line || 0) - (b.sourceLocation?.line || 0);
    })
    .map((p) => {
      const pkgTag = p.packageVersion ? `${p.packageName}@${p.packageVersion}` : p.packageName;
      const loc =
        p.moduleContext && p.sourceLocation
          ? `${p.moduleContext}:${p.sourceLocation.line}:${p.sourceLocation.column}`
          : p.sourceLocation
          ? `line ${p.sourceLocation.line}:${p.sourceLocation.column}`
          : p.moduleContext || "";

      if (loc && p.listenerMethod) {
        return `${pkgTag} (${p.listenerMethod} at ${loc})`;
      }
      if (p.listenerMethod) {
        return `${pkgTag} (${p.listenerMethod})`;
      }
      return pkgTag;
    });

  const uniqueDetails = [...new Set(participantDetails)];
  const detailsStr = uniqueDetails.length > 0 ? ` [${uniqueDetails.join("; ")}]` : "";

  return `${packageLabel} (${ownersList}) register listeners on "${group.canonicalTarget}"${detailsStr}. ${rationale}`;
}

/**
 * Creates a complete shared Finding for a listener collision group.
 */
export function createListenerFinding(group: ListenerCollisionGroup): Finding {
  return {
    scanner: "event-listeners",
    severity: classifyListenerSeverity(group),
    target: group.canonicalTarget,
    owners: group.owners,
    message: formatFindingMessage(group),
  };
}

export const eventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = await Promise.all(
      pkgs.map((p) => getOrCache(p, extractPackageProfile)),
    );
    const collisions = groupListenerCollisions(pkgs, profiles);
    return collisions.map(createListenerFinding);
  },
};

