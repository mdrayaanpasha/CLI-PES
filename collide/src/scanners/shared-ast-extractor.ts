import ts from "typescript";

export type TargetIdentityType = "window" | "document" | "element" | "emitter" | "unknown";
export type ReceiverScope = "global" | "dom" | "module" | "unknown";

export interface SourceLocation {
  line: number;
  column: number;
}

export interface TargetIdentity {
  type: TargetIdentityType;
  /** Name of the target variable, property, or specific identity. */
  name?: string;
}

export interface ListenerRegistration {
  targetIdentity: TargetIdentity;
  receiverScope: ReceiverScope;
  listenerMethod: string;
  eventName: string;
  sourceLocation: SourceLocation;
  packageContext?: string;
  moduleContext?: string;
}

export interface PackageProfile {
  writes: string[];     // global / prototype write targets, e.g. "Array.prototype.flat"
  listeners: ListenerRegistration[];  // typed event-listener registrations
}

export const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
  "addEventListener",
]);

/**
 * Statically extracts and normalizes an event name from an AST expression node.
 * Returns the normalized static event name string, or "<unknown>" if dynamic or unsupported.
 */
export function extractEventName(arg?: ts.Expression): string {
  if (!arg) return "<unknown>";

  while (ts.isParenthesizedExpression(arg)) {
    arg = arg.expression;
  }

  // String literals (single / double quoted): "click", 'data'
  // No-substitution template literals: `click`
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }

  // Numeric literals: 123 -> "123"
  if (ts.isNumericLiteral(arg)) {
    return arg.text;
  }

  // Static string concatenation: "data" + "ready", `prefix-` + 'event'
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractEventName(arg.left);
    const right = extractEventName(arg.right);
    if (left !== "<unknown>" && right !== "<unknown>") {
      return left + right;
    }
    return "<unknown>";
  }

  // Static template expressions with static substitutions: e.g. `foo-${"bar"}`
  if (ts.isTemplateExpression(arg)) {
    let result = arg.head.text;
    for (const span of arg.templateSpans) {
      const spanVal = extractEventName(span.expression);
      if (spanVal === "<unknown>") {
        return "<unknown>";
      }
      result += spanVal + span.literal.text;
    }
    return result;
  }

  return "<unknown>";
}

type Binding =
  | { kind: "variable"; declaration: ts.VariableDeclaration }
  | { kind: "parameter"; parameter: ts.ParameterDeclaration }
  | { kind: "import"; declaration: ts.ImportDeclaration; specifierText: string; isDefaultOrNamespaceOrProcess: boolean }
  | { kind: "function"; declaration: ts.FunctionDeclaration }
  | { kind: "class"; declaration: ts.ClassDeclaration }
  | { kind: "catch"; clause: ts.CatchClause };

export function findBinding(startNode: ts.Node, targetName: string): Binding | null {
  let curr: ts.Node | undefined = startNode.parent;
  while (curr) {
    // 1. Function / Method / Arrow / Constructor parameters
    if (
      ts.isFunctionDeclaration(curr) ||
      ts.isFunctionExpression(curr) ||
      ts.isArrowFunction(curr) ||
      ts.isMethodDeclaration(curr) ||
      ts.isConstructorDeclaration(curr)
    ) {
      for (const param of curr.parameters) {
        if (ts.isIdentifier(param.name) && param.name.text === targetName) {
          return { kind: "parameter", parameter: param };
        }
      }
    }

    // 2. Catch clause parameter
    if (ts.isCatchClause(curr) && curr.variableDeclaration) {
      if (
        ts.isIdentifier(curr.variableDeclaration.name) &&
        curr.variableDeclaration.name.text === targetName
      ) {
        return { kind: "catch", clause: curr };
      }
    }

    // 3. Statements in Block, SourceFile, ModuleBlock
    let statements: ts.NodeArray<ts.Statement> | undefined;
    if (ts.isBlock(curr) || ts.isSourceFile(curr) || ts.isModuleBlock(curr)) {
      statements = curr.statements;
    }

    if (statements) {
      for (const stmt of statements) {
        if (ts.isVariableStatement(stmt)) {
          for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === targetName) {
              return { kind: "variable", declaration: decl };
            }
          }
        }
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.name.text === targetName) {
          return { kind: "function", declaration: stmt };
        }
        if (ts.isClassDeclaration(stmt) && stmt.name && stmt.name.text === targetName) {
          return { kind: "class", declaration: stmt };
        }
        if (ts.isImportDeclaration(stmt) && stmt.importClause) {
          const clause = stmt.importClause;
          const moduleSpecifier = ts.isStringLiteral(stmt.moduleSpecifier)
            ? stmt.moduleSpecifier.text
            : "";
          const isProcessModule =
            moduleSpecifier === "process" || moduleSpecifier === "node:process";

          if (clause.name && clause.name.text === targetName) {
            return {
              kind: "import",
              declaration: stmt,
              specifierText: moduleSpecifier,
              isDefaultOrNamespaceOrProcess: isProcessModule,
            };
          }
          if (clause.namedBindings) {
            if (
              ts.isNamespaceImport(clause.namedBindings) &&
              clause.namedBindings.name.text === targetName
            ) {
              return {
                kind: "import",
                declaration: stmt,
                specifierText: moduleSpecifier,
                isDefaultOrNamespaceOrProcess: isProcessModule,
              };
            }
            if (ts.isNamedImports(clause.namedBindings)) {
              for (const element of clause.namedBindings.elements) {
                if (element.name.text === targetName) {
                  return {
                    kind: "import",
                    declaration: stmt,
                    specifierText: moduleSpecifier,
                    isDefaultOrNamespaceOrProcess: isProcessModule,
                  };
                }
              }
            }
          }
        }
      }
    }

    curr = curr.parent;
  }
  return null;
}

export function isGlobalProcessReceiver(expr: ts.Expression, visited = new Set<ts.Node>()): boolean {
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }

  if (visited.has(expr)) return false;
  visited.add(expr);

  // 1. Direct identifier `process` or alias
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const binding = findBinding(expr, name);

    // If no binding found: if name === "process", it refers to global `process`!
    if (!binding) {
      return name === "process";
    }

    // If binding found:
    if (binding.kind === "variable") {
      const init = binding.declaration.initializer;
      if (!init) return false;
      return isGlobalProcessReceiver(init, visited);
    }

    if (binding.kind === "import") {
      return binding.isDefaultOrNamespaceOrProcess;
    }

    return false;
  }

  // 2. MemberExpression: globalThis.process, global.process, or window.process
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    if (propName === "process") {
      let baseExpr: ts.Expression = expr.expression;
      while (ts.isParenthesizedExpression(baseExpr)) {
        baseExpr = baseExpr.expression;
      }
      if (ts.isIdentifier(baseExpr)) {
        const baseName = baseExpr.text;
        if (baseName === "globalThis" || baseName === "global" || baseName === "window") {
          const baseBinding = findBinding(baseExpr, baseName);
          if (!baseBinding) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // 3. CallExpression: require("process") or require("node:process")
  if (ts.isCallExpression(expr)) {
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isIdentifier(callee) && callee.text === "require") {
      const requireBinding = findBinding(callee, "require");
      if (!requireBinding) {
        if (expr.arguments.length > 0) {
          let arg0 = expr.arguments[0];
          while (ts.isParenthesizedExpression(arg0)) {
            arg0 = arg0.expression;
          }
          if (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0)) {
            const mod = arg0.text;
            return mod === "process" || mod === "node:process";
          }
        }
      }
    }
    return false;
  }

  return false;
}

export function isGlobalThisReceiver(expr: ts.Expression, visited = new Set<ts.Node>()): boolean {
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }

  if (visited.has(expr)) return false;
  visited.add(expr);

  // 1. Identifier `globalThis` or `global` or alias
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const binding = findBinding(expr, name);
    if (!binding) {
      return name === "globalThis" || name === "global";
    }
    if (binding.kind === "variable") {
      const init = binding.declaration.initializer;
      if (!init) return false;
      return isGlobalThisReceiver(init, visited);
    }
    return false;
  }

  return false;
}

export function isGlobalWindowReceiver(expr: ts.Expression, visited = new Set<ts.Node>()): boolean {
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }

  if (visited.has(expr)) return false;
  visited.add(expr);

  // 1. Direct identifier `window` or alias
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const binding = findBinding(expr, name);
    if (!binding) {
      return name === "window";
    }
    if (binding.kind === "variable") {
      const init = binding.declaration.initializer;
      if (!init) return false;
      return isGlobalWindowReceiver(init, visited);
    }
    return false;
  }

  // 2. MemberExpression: globalThis.window or global.window
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    if (propName === "window") {
      let baseExpr: ts.Expression = expr.expression;
      while (ts.isParenthesizedExpression(baseExpr)) {
        baseExpr = baseExpr.expression;
      }
      if (isGlobalThisReceiver(baseExpr, new Set(visited))) {
        return true;
      }
    }
    return false;
  }

  return false;
}

export function isGlobalDocumentReceiver(expr: ts.Expression, visited = new Set<ts.Node>()): boolean {
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }

  if (visited.has(expr)) return false;
  visited.add(expr);

  // 1. Direct identifier `document` or alias
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const binding = findBinding(expr, name);
    if (!binding) {
      return name === "document";
    }
    if (binding.kind === "variable") {
      const init = binding.declaration.initializer;
      if (!init) return false;
      return isGlobalDocumentReceiver(init, visited);
    }
    return false;
  }

  // 2. MemberExpression: globalThis.document, global.document, or window.document
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    if (propName === "document") {
      let baseExpr: ts.Expression = expr.expression;
      while (ts.isParenthesizedExpression(baseExpr)) {
        baseExpr = baseExpr.expression;
      }
      if (
        isGlobalThisReceiver(baseExpr, new Set(visited)) ||
        isGlobalWindowReceiver(baseExpr, new Set(visited))
      ) {
        return true;
      }
    }
    return false;
  }

  return false;
}

function resolveTargetAndScope(
  receiverExpr: ts.Expression,
  cleanReceiverText: string,
  methodName: string,
): { targetIdentity: TargetIdentity; receiverScope: ReceiverScope } {
  // 1. Global Node.js process receiver
  if (isGlobalProcessReceiver(receiverExpr)) {
    return {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
    };
  }

  // 2. Global browser window receiver (window, globalThis.window, etc.)
  if (isGlobalWindowReceiver(receiverExpr)) {
    return {
      targetIdentity: { type: "window" },
      receiverScope: "global",
    };
  }

  // 3. Global browser document receiver (document, globalThis.document, window.document, etc.)
  if (isGlobalDocumentReceiver(receiverExpr)) {
    return {
      targetIdentity: { type: "document" },
      receiverScope: "global",
    };
  }

  // 4. GlobalThis receiver directly
  if (isGlobalThisReceiver(receiverExpr)) {
    if (methodName === "addEventListener") {
      return {
        targetIdentity: { type: "window" },
        receiverScope: "global",
      };
    }
    return {
      targetIdentity: {
        type: "emitter",
        name: cleanReceiverText === "global" ? "global" : "globalThis",
      },
      receiverScope: "global",
    };
  }

  // 5. General DOM addEventListener on elements
  if (methodName === "addEventListener") {
    if (cleanReceiverText) {
      return {
        targetIdentity: { type: "element", name: cleanReceiverText },
        receiverScope: "dom",
      };
    }
    return {
      targetIdentity: { type: "unknown" },
      receiverScope: "unknown",
    };
  }

  // 6. General emitter methods
  if (
    methodName === "on" ||
    methodName === "once" ||
    methodName === "addListener" ||
    methodName === "prependListener" ||
    methodName === "prependOnceListener"
  ) {
    if (cleanReceiverText) {
      return {
        targetIdentity: { type: "emitter", name: cleanReceiverText },
        receiverScope: "module",
      };
    }
    return {
      targetIdentity: { type: "unknown" },
      receiverScope: "unknown",
    };
  }

  return {
    targetIdentity: cleanReceiverText
      ? { type: "unknown", name: cleanReceiverText }
      : { type: "unknown" },
    receiverScope: "unknown",
  };
}

export function extractPackageProfile(
  sourceCode: string,
  packageContext?: string,
  moduleContext?: string,
): PackageProfile {
  const sourceFile = ts.createSourceFile(
    moduleContext ?? "source.ts",
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  function setParentPointers(node: ts.Node, parent?: ts.Node) {
    if (parent) {
      (node as any).parent = parent;
    }
    ts.forEachChild(node, (child) => setParentPointers(child, node));
  }
  setParentPointers(sourceFile);

  const listeners: ListenerRegistration[] = [];
  const writes: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      let expr: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(expr)) {
        expr = expr.expression;
      }

      let methodName: string | null = null;
      let receiverExpr: ts.Expression | null = null;

      if (ts.isPropertyAccessExpression(expr)) {
        methodName = expr.name.text;
        receiverExpr = expr.expression;
      } else if (ts.isElementAccessExpression(expr)) {
        let arg = expr.argumentExpression;
        while (ts.isParenthesizedExpression(arg)) {
          arg = arg.expression;
        }
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          methodName = arg.text;
          receiverExpr = expr.expression;
        }
      }

      if (methodName && LISTENER_METHODS.has(methodName) && receiverExpr) {
        while (ts.isParenthesizedExpression(receiverExpr)) {
          receiverExpr = receiverExpr.expression;
        }
        const cleanReceiverText = receiverExpr.getText(sourceFile).replace(/\s+/g, " ").trim();

        const { targetIdentity, receiverScope } = resolveTargetAndScope(
          receiverExpr,
          cleanReceiverText,
          methodName,
        );
        const eventName = extractEventName(node.arguments[0]);
        const pos = node.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);

        const registration: ListenerRegistration = {
          targetIdentity,
          receiverScope,
          listenerMethod: methodName,
          eventName,
          sourceLocation: {
            line: line + 1,
            column: character,
          },
          ...(packageContext !== undefined ? { packageContext } : {}),
          ...(moduleContext !== undefined ? { moduleContext } : {}),
        };

        listeners.push(registration);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { writes, listeners };
}
