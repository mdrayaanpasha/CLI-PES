// test/osv.test.ts
// Tests the OSV scanner with a MOCKED fetch — no network, fully deterministic.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createOsvScanner, mapSeverity } from "../src/scanners/osv";
import type { ResolvedPackage } from "../src/core/types";

const PKGS: ResolvedPackage[] = [
  { name: "lodash", version: "4.17.4" }, // pretend-vulnerable
  { name: "safe-pkg", version: "1.0.0" }, // clean
];

/** Build a fake fetch that serves canned querybatch + vuln-detail responses. */
function mockFetch(
  batch: Array<{ vulns?: Array<{ id: string }> }>,
  vulns: Record<string, unknown>,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v1/querybatch")) {
      return new Response(JSON.stringify({ results: batch }), { status: 200 });
    }
    const m = u.match(/\/v1\/vulns\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const v = vulns[id];
      return v
        ? new Response(JSON.stringify(v), { status: 200 })
        : new Response("not found", { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("OSV scanner (mocked network)", () => {
  test("maps querybatch + vuln details into findings", async () => {
    const fetchImpl = mockFetch(
      [{ vulns: [{ id: "GHSA-test-high" }] }, {}], // lodash has 1 vuln, safe-pkg none
      {
        "GHSA-test-high": {
          id: "GHSA-test-high",
          summary: "Prototype pollution in lodash",
          database_specific: { severity: "HIGH" },
        },
      },
    );
    const scanner = createOsvScanner({ fetchImpl });
    const findings = await scanner.scan(PKGS);

    assert.equal(findings.length, 1);
    assert.deepEqual(findings[0], {
      scanner: "osv",
      severity: "high",
      target: "GHSA-test-high",
      owners: ["lodash@4.17.4"],
      message: "Prototype pollution in lodash",
    });
  });

  test("de-dupes detail fetches when a vuln hits multiple packages", async () => {
    let vulnFetches = 0;
    const base = mockFetch(
      [{ vulns: [{ id: "SHARED" }] }, { vulns: [{ id: "SHARED" }] }],
      { SHARED: { id: "SHARED", summary: "shared", database_specific: { severity: "LOW" } } },
    );
    const counting: typeof fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/v1/vulns/")) vulnFetches++;
      return base(url as string, init as RequestInit);
    }) as unknown as typeof fetch;

    const findings = await createOsvScanner({ fetchImpl: counting }).scan(PKGS);
    assert.equal(findings.length, 2, "one finding per affected package");
    assert.equal(vulnFetches, 1, "vuln detail fetched only once");
  });

  test("network failure degrades to empty findings, no throw", async () => {
    const failing: typeof fetch = (async () => {
      throw new Error("ENOTFOUND api.osv.dev");
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    const findings = await createOsvScanner({
      fetchImpl: failing,
      onWarn: (m) => warnings.push(m),
    }).scan(PKGS);
    assert.deepEqual(findings, []);
    assert.equal(warnings.length, 1);
  });

  test("empty package list short-circuits", async () => {
    const findings = await createOsvScanner({
      fetchImpl: (() => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    }).scan([]);
    assert.deepEqual(findings, []);
  });
});

describe("OSV severity mapping", () => {
  test("maps GHSA severity labels", () => {
    assert.equal(mapSeverity({ id: "x", database_specific: { severity: "CRITICAL" } }), "high");
    assert.equal(mapSeverity({ id: "x", database_specific: { severity: "MODERATE" } }), "medium");
    assert.equal(mapSeverity({ id: "x", database_specific: { severity: "LOW" } }), "low");
  });

  test("falls back to CVSS numeric score", () => {
    assert.equal(
      mapSeverity({ id: "x", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/8.1" }] }),
      "high",
    );
  });

  test("unknown severity defaults to medium", () => {
    assert.equal(mapSeverity({ id: "x" }), "medium");
  });
});
