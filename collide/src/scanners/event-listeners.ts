// scanners/event-listeners.ts
// Scan 3: same profiles as global-state, different bucket (listeners).

import type { Scanner } from "../core/types";
import { getOrCache } from "../cache/db";
import { extractPackageProfile, ListenerRegistration } from "./shared-ast-extractor";
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

export const eventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = await Promise.all(
      pkgs.map((p) => getOrCache(p, extractPackageProfile)),
    );
    return groupByTarget(pkgs, profiles, "listeners", getListenerId)
      .filter((g) => g.owners.length >= 2)
      .map((g) => ({
        scanner: "event-listeners" as const,
        severity: "medium" as const,
        target: g.target,
        owners: g.owners,
        message: `${g.owners.length} packages register a listener on "${g.target}"`,
      }));
  },
};
