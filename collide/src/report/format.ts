// report/format.ts
// Render findings as a table or JSON.

import type { Finding, OutputFormat } from "../core/types";

export function printReport(findings: Finding[], format: OutputFormat): void {
  if (format === "json") {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  if (findings.length === 0) {
    console.log("No collisions found.");
    return;
  }

  // TODO: pretty table. Minimal version for now:
  for (const f of findings) {
    console.log(
      `[${f.severity.toUpperCase()}] ${f.scanner}: ${f.target} — ${f.message}`,
    );
  }
}
