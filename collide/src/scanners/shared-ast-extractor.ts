// scanners/shared-ast-extractor.ts
// One AST walk, two output buckets — shared by global-state and event-listeners.

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type {
  CallExpression,
  Expression,
  MemberExpression,
  Node,
  PrivateName,
} from "@babel/types";

// @babel/traverse ships as CJS; under ESM the callable is on `.default`.
const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

export interface PackageProfile {
  writes: string[]; // global / prototype write targets, e.g. "Array.prototype.flat"
  listeners: string[]; // event-listener registrations, e.g. "window:resize"
}

const GLOBAL_ROOTS = new Set(["window", "globalThis", "global", "self"]);
const BUILTIN_PROTOS = new Set([
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Function",
  "Date",
  "RegExp",
  "Promise",
  "Map",
  "Set",
  "Symbol",
  "Error",
]);
const LISTENER_ROOTS = new Set(["window", "document", "global", "globalThis", "process", "self"]);

/** Resolve a dotted member path like `Array.prototype.flat` to a string, else null. */
function memberPath(node: Expression | PrivateName): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    const obj = memberPath(node.object as Expression);
    const prop = node.property;
    if (obj && prop.type === "Identifier") return `${obj}.${prop.name}`;
  }
  return null;
}

/**
 * A member path is "interesting" as a write target if it hits a global or a
 * builtin prototype. Matches both `Array.prototype.flat` (assignment target)
 * and `String.prototype` (a defineProperty target).
 */
function isInterestingWriteTarget(path: string): boolean {
  const root = path.split(".")[0];
  if (GLOBAL_ROOTS.has(root)) return true;
  if (BUILTIN_PROTOS.has(root) && /\.prototype(\.|$)/.test(path)) return true;
  return false;
}

function staticString(node: Node | null | undefined): string | null {
  if (node && node.type === "StringLiteral") return node.value;
  return null;
}

function recordWrite(target: MemberExpression, writes: Set<string>): void {
  const p = memberPath(target);
  if (p && isInterestingWriteTarget(p)) writes.add(p);
}

function handleDefineProperty(call: CallExpression, writes: Set<string>): void {
  const callee = call.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "defineProperty"
  ) {
    return;
  }
  const targetArg = call.arguments[0];
  const keyArg = call.arguments[1];
  if (!targetArg || targetArg.type === "SpreadElement") return;
  const targetPath = memberPath(targetArg as Expression);
  const key = staticString(keyArg);
  if (targetPath && isInterestingWriteTarget(targetPath) && key) {
    writes.add(`${targetPath}.${key}`);
  }
}

function handleListener(call: CallExpression, listeners: Set<string>): void {
  const callee = call.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return;
  if (callee.property.type !== "Identifier") return;
  const method = callee.property.name;
  if (method !== "addEventListener" && method !== "on") return;

  const evt = staticString(call.arguments[0]);
  if (!evt) return;

  const rootPath = memberPath(callee.object as Expression);
  const root = rootPath ? rootPath.split(".")[0] : null;

  if (method === "addEventListener") {
    listeners.add(`${root ?? "?"}:${evt}`);
  } else if (root && LISTENER_ROOTS.has(root)) {
    // only flag .on() on known global-ish emitters to avoid noise
    listeners.add(`${root}:${evt}`);
  }
}

export function extractPackageProfile(sourceCode: string): PackageProfile {
  const writes = new Set<string>();
  const listeners = new Set<string>();

  let ast;
  try {
    ast = parse(sourceCode, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
    });
  } catch {
    // unparseable source → empty profile, never crash the run
    return { writes: [], listeners: [] };
  }

  try {
    traverse(ast, {
      AssignmentExpression(path: NodePath<import("@babel/types").AssignmentExpression>) {
        const left = path.node.left;
        if (left.type === "MemberExpression") recordWrite(left, writes);
      },
      CallExpression(path: NodePath<CallExpression>) {
        handleDefineProperty(path.node, writes);
        handleListener(path.node, listeners);
      },
    });
  } catch {
    // traversal hiccup → return whatever we collected so far
  }

  return { writes: [...writes], listeners: [...listeners] };
}
