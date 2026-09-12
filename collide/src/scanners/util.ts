// scanners/util.ts
// Small grouping helpers shared by scanners.

import type { ResolvedPackage } from "../core/types.js";
import type { PackageProfile } from "./shared-ast-extractor.js";

export function groupBy<T>(
  items: T[],
  key: (item: T) => string,
): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

export interface TargetGroup {
  target: string;
  owners: string[]; // package names that touch this target
}

/**
 * Invert profiles into groups keyed by target (a write or a listener),
 * where `owners` is the set of packages touching that target.
 */
export function groupByTarget<K extends keyof PackageProfile>(
  pkgs: ResolvedPackage[],
  profiles: PackageProfile[],
  bucket: K,
  getTargetId: (item: PackageProfile[K][number]) => string = String,
): TargetGroup[] {
  const map = new Map<string, Set<string>>();
  profiles.forEach((profile, i) => {
    const owner = pkgs[i].name;
    const items = profile[bucket];
    for (const item of items) {
      const target = getTargetId(item);
      (map.get(target) ?? map.set(target, new Set()).get(target)!).add(owner);
    }
  });
  return [...map.entries()].map(([target, owners]) => ({
    target,
    owners: [...owners],
  }));
}
