---
description: Scan a dependency manifest for vulnerabilities and collisions with collide
argument-hint: "[path to lockfile, e.g. ./package-lock.json]"
---

Use the `scan_dependencies` tool from the collide MCP server to scan the
dependency manifest at: `$ARGUMENTS`

If no path was given, look in the current working directory for a supported
manifest and scan the first one you find, in this order:
`package-lock.json`, `go.sum`, `requirements.txt`, `Cargo.lock`, `composer.lock`.

After the scan returns, summarize the findings for the user:
- the ecosystem, package count, and total findings with the severity breakdown
- the high-severity findings first (vulnerability id / target and the owning packages)
- any duplicate/conflicting versions and cross-package collisions
- a short, prioritized "what to fix first" recommendation

Keep it concise and skimmable.
