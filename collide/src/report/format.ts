import type { Finding, OutputFormat } from "../core/types.js";

export function formatReport(findings: Finding[], format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(findings, null, 2);
  }

  if (findings.length === 0) {
    return "No collisions found.";
  }

  return findings
    .map(
      (f) =>
        `[${f.severity.toUpperCase()}] ${f.scanner}: ${f.target} — ${f.message}`,
    )
    .join("\n");
}

export function printReport(findings: Finding[], format: OutputFormat): void {
  console.log(formatReport(findings, format));
}

