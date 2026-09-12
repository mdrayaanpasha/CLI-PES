// scanners/event-listeners.ts
// Scan 3: same profiles as global-state, different bucket (listeners).

import type { ResolvedPackage, Scanner } from "../core/types";
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
 * tracking participant metadata and filtering only cross-package collisions (2+ distinct packages).
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
    if (ownersSet.size >= 2) {
      collisions.push({
        canonicalTarget,
        owners: [...ownersSet],
        participants,
      });
    }
  }

  return collisions;
}

export const eventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = await Promise.all(
      pkgs.map((p) => getOrCache(p, extractPackageProfile)),
    );
    const collisions = groupListenerCollisions(pkgs, profiles);
    return collisions.map((c) => ({
      scanner: "event-listeners" as const,
      severity: "medium" as const,
      target: c.canonicalTarget,
      owners: c.owners,
      message: `${c.owners.length} packages register a listener on "${c.canonicalTarget}"`,
    }));
  },
};
