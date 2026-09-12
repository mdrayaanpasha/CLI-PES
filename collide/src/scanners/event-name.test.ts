import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { extractEventName } from "./shared-ast-extractor";

function parseExpr(code: string): ts.Expression | undefined {
  const sf = ts.createSourceFile("snippet.ts", `fn(${code})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const stmt = sf.statements[0] as ts.ExpressionStatement;
  const call = stmt.expression as ts.CallExpression;
  return call.arguments[0];
}

describe("extractEventName Static Event-Name Extraction and Normalization", () => {
  describe("Single and double quoted strings", () => {
    it("extracts single-quoted string literals", () => {
      assert.equal(extractEventName(parseExpr("'click'")), "click");
      assert.equal(extractEventName(parseExpr("'data'")), "data");
      assert.equal(extractEventName(parseExpr("'DOMContentLoaded'")), "DOMContentLoaded");
    });

    it("extracts double-quoted string literals", () => {
      assert.equal(extractEventName(parseExpr('"click"')), "click");
      assert.equal(extractEventName(parseExpr('"data"')), "data");
      assert.equal(extractEventName(parseExpr('"resize"')), "resize");
    });
  });

  describe("Static template literals", () => {
    it("extracts static template literals with no substitutions", () => {
      assert.equal(extractEventName(parseExpr("`click`")), "click");
      assert.equal(extractEventName(parseExpr("`data`")), "data");
      assert.equal(extractEventName(parseExpr("`ready`")), "ready");
    });

    it("extracts template literals with only static sub-expressions", () => {
      assert.equal(extractEventName(parseExpr("`user-${'login'}`")), "user-login");
      assert.equal(extractEventName(parseExpr("`prefix-${`event`}`")), "prefix-event");
    });
  });

  describe("Numeric literals", () => {
    it("extracts numeric literals normalized to strings", () => {
      assert.equal(extractEventName(parseExpr("0")), "0");
      assert.equal(extractEventName(parseExpr("123")), "123");
      assert.equal(extractEventName(parseExpr("42")), "42");
    });
  });

  describe("Empty event names", () => {
    it("preserves empty static string and template values", () => {
      assert.equal(extractEventName(parseExpr('""')), "");
      assert.equal(extractEventName(parseExpr("''")), "");
      assert.equal(extractEventName(parseExpr("``")), "");
    });
  });

  describe("Unusual but valid static strings", () => {
    it("preserves special characters, spaces, and punctuation in static strings", () => {
      assert.equal(extractEventName(parseExpr('"custom:event.v1"')), "custom:event.v1");
      assert.equal(extractEventName(parseExpr('"event with spaces"')), "event with spaces");
      assert.equal(extractEventName(parseExpr('"weird:event.name#123@$"')), "weird:event.name#123@$");
      assert.equal(extractEventName(parseExpr('"::"')), "::");
      assert.equal(extractEventName(parseExpr('"é:🎉"')), "é:🎉");
      assert.equal(extractEventName(parseExpr('"$on_init"')), "$on_init");
    });
  });

  describe("String concatenation", () => {
    it("extracts fully static binary concatenations", () => {
      assert.equal(extractEventName(parseExpr('"user:" + "login"')), "user:login");
      assert.equal(extractEventName(parseExpr('"a" + "b" + "c"')), "abc");
      assert.equal(extractEventName(parseExpr('("foo") + ("bar")')), "foobar");
      assert.equal(extractEventName(parseExpr('`prefix-` + "event"')), "prefix-event");
    });

    it("returns <unknown> when concatenation involves dynamic parts", () => {
      assert.equal(extractEventName(parseExpr('"user:" + type')), "<unknown>");
      assert.equal(extractEventName(parseExpr('prefix + ":event"')), "<unknown>");
      assert.equal(extractEventName(parseExpr('a + b')), "<unknown>");
      assert.equal(extractEventName(parseExpr('"data:" + getEvent()')), "<unknown>");
    });
  });

  describe("Dynamic and unsupported AST expressions", () => {
    it("returns <unknown> for dynamic template literals with expressions", () => {
      assert.equal(extractEventName(parseExpr("`click-${type}`")), "<unknown>");
      assert.equal(extractEventName(parseExpr("`${prefix}:ready`")), "<unknown>");
      assert.equal(extractEventName(parseExpr("`event-${getEventId()}`")), "<unknown>");
    });

    it("returns <unknown> for identifiers", () => {
      assert.equal(extractEventName(parseExpr("eventName")), "<unknown>");
      assert.equal(extractEventName(parseExpr("MY_EVENT_CONST")), "<unknown>");
      assert.equal(extractEventName(parseExpr("undefined")), "<unknown>");
    });

    it("returns <unknown> for function calls", () => {
      assert.equal(extractEventName(parseExpr("getEventName()")), "<unknown>");
      assert.equal(extractEventName(parseExpr("computeEvent('click')")), "<unknown>");
    });

    it("returns <unknown> for member expressions and property access", () => {
      assert.equal(extractEventName(parseExpr("Events.CLICK")), "<unknown>");
      assert.equal(extractEventName(parseExpr("this.eventName")), "<unknown>");
      assert.equal(extractEventName(parseExpr("events[0]")), "<unknown>");
    });

    it("returns <unknown> for conditional/ternary expressions", () => {
      assert.equal(extractEventName(parseExpr('isMobile ? "touchstart" : "mousedown"')), "<unknown>");
    });

    it("returns <unknown> for other non-string literal expressions", () => {
      assert.equal(extractEventName(parseExpr("null")), "<unknown>");
      assert.equal(extractEventName(parseExpr("true")), "<unknown>");
      assert.equal(extractEventName(parseExpr("Symbol('event')")), "<unknown>");
      assert.equal(extractEventName(parseExpr("{}")), "<unknown>");
      assert.equal(extractEventName(parseExpr("[]")), "<unknown>");
      assert.equal(extractEventName(undefined), "<unknown>");
    });
  });
});
