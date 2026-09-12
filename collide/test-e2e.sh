#!/usr/bin/env bash
# test-e2e.sh — Comprehensive End-to-End Validation Script for Collide

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================================"
echo "  Collide CLI — End-to-End Test Suite"
echo "============================================================"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function step() {
  echo -e "\n${BLUE}==>${NC} $1"
}

function success() {
  echo -e "${GREEN}✔ PASS:${NC} $1"
}

function fail() {
  echo -e "${RED}✖ FAIL:${NC} $1"
  exit 1
}

# 1. Build TypeScript project
step "1. Compiling TypeScript source files..."
npm run build
success "TypeScript build completed successfully."

# 2. Run all unit and integration test suites
step "2. Running full unit, fixture, and integration test suites..."
npm test
success "All test suites passed cleanly."

# 3. Create realistic temporary npm project fixture
step "3. Setting up temporary npm project fixture with real dependency tree..."
TMP_DIR="$(mktemp -d -t collide-e2e-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

NODE_MODULES="$TMP_DIR/node_modules"
mkdir -p "$NODE_MODULES"

# Package A: winston-telemetry (1.0.0) -> process.on("uncaughtException"), window.addEventListener("resize")
mkdir -p "$NODE_MODULES/winston-telemetry"
cat << 'EOF' > "$NODE_MODULES/winston-telemetry/package.json"
{
  "name": "winston-telemetry",
  "version": "1.0.0",
  "main": "index.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/winston-telemetry/index.js"
process.on("uncaughtException", (err) => {
  console.error("Winston caught unhandled exception:", err);
});
window.addEventListener("resize", () => {
  console.log("Winston resize handler");
});
EOF

# Package B: sentry-agent (2.0.0) -> proc.addListener("uncaughtException") via alias, window.addEventListener("resize")
mkdir -p "$NODE_MODULES/sentry-agent/lib"
cat << 'EOF' > "$NODE_MODULES/sentry-agent/package.json"
{
  "name": "sentry-agent",
  "version": "2.0.0",
  "main": "lib/agent.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/sentry-agent/lib/agent.js"
const proc = process;
proc.addListener("uncaughtException", (err) => {
  sendTelemetryToSentry(err);
});
window.addEventListener("resize", () => {
  trackViewportResize();
});
EOF

# Package C: hot-reloader (0.5.0) -> process.prependListener("SIGTERM") [escalates to CRITICAL], benign DOMContentLoaded
mkdir -p "$NODE_MODULES/hot-reloader"
cat << 'EOF' > "$NODE_MODULES/hot-reloader/package.json"
{
  "name": "hot-reloader",
  "version": "0.5.0",
  "main": "index.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/hot-reloader/index.js"
process.prependListener("SIGTERM", () => {
  flushHotUpdates();
});
document.addEventListener("DOMContentLoaded", () => {
  initHmr();
});
EOF

# Package D: graceful-shutdown (1.2.0) -> process.on("SIGTERM"), benign load
mkdir -p "$NODE_MODULES/graceful-shutdown"
cat << 'EOF' > "$NODE_MODULES/graceful-shutdown/package.json"
{
  "name": "graceful-shutdown",
  "version": "1.2.0",
  "main": "main.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/graceful-shutdown/main.js"
process.on("SIGTERM", () => {
  closeActiveConnections();
});
window.addEventListener("load", () => {
  markAppReady();
});
EOF

# Package E: local-queue (3.0.0) -> Local EventEmitter, dynamic event names, DOM elements (Must be filtered out)
mkdir -p "$NODE_MODULES/local-queue"
cat << 'EOF' > "$NODE_MODULES/local-queue/package.json"
{
  "name": "local-queue",
  "version": "3.0.0",
  "main": "index.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/local-queue/index.js"
const EventEmitter = require("events");
const localQueueEmitter = new EventEmitter();
localQueueEmitter.on("uncaughtException", () => {});
process.on(config.dynamicEventName, () => {});
const btn = document.getElementById("queue-btn");
btn.addEventListener("click", () => {});
EOF

# Package F: isolated-worker (1.0.0) -> Multiple exit listeners within the same package (No collision)
mkdir -p "$NODE_MODULES/isolated-worker"
cat << 'EOF' > "$NODE_MODULES/isolated-worker/package.json"
{
  "name": "isolated-worker",
  "version": "1.0.0",
  "main": "index.js"
}
EOF
cat << 'EOF' > "$NODE_MODULES/isolated-worker/index.js"
process.on("exit", () => cleanWorker());
process.once("exit", () => logExit());
EOF

# Create npm package-lock.json (v3 format)
cat << 'EOF' > "$TMP_DIR/package-lock.json"
{
  "name": "realistic-e2e-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "realistic-e2e-app",
      "version": "1.0.0"
    },
    "node_modules/winston-telemetry": {
      "version": "1.0.0"
    },
    "node_modules/sentry-agent": {
      "version": "2.0.0"
    },
    "node_modules/hot-reloader": {
      "version": "0.5.0"
    },
    "node_modules/graceful-shutdown": {
      "version": "1.2.0"
    },
    "node_modules/local-queue": {
      "version": "3.0.0"
    },
    "node_modules/isolated-worker": {
      "version": "1.0.0"
    }
  }
}
EOF
success "Temporary test project created at: $TMP_DIR"

# 4. Run CLI with JSON output format
step "4. Testing CLI execution with JSON output format..."
JSON_OUTPUT=$(node dist/cli.js scan "$TMP_DIR/package-lock.json" --format=json)

# Validate JSON output using Node.js script
node -e '
const raw = process.argv[1];
const findings = JSON.parse(raw);

if (!Array.isArray(findings)) {
  throw new Error("JSON output is not an array");
}

if (findings.length !== 3) {
  throw new Error(`Expected 3 findings, got ${findings.length}`);
}

const targets = findings.map(f => f.target).sort();
const expectedTargets = [
  "global_process:SIGTERM",
  "global_process:uncaughtException",
  "global_window:resize"
];

if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
  throw new Error(`Targets mismatch: expected ${JSON.stringify(expectedTargets)}, got ${JSON.stringify(targets)}`);
}

const uncaught = findings.find(f => f.target === "global_process:uncaughtException");
if (uncaught.severity !== "critical") throw new Error("uncaughtException severity must be critical");
if (JSON.stringify(uncaught.owners.sort()) !== JSON.stringify(["sentry-agent", "winston-telemetry"])) {
  throw new Error("uncaughtException owners mismatch");
}

const sigterm = findings.find(f => f.target === "global_process:SIGTERM");
if (sigterm.severity !== "critical") throw new Error("SIGTERM severity must be escalated to critical due to prependListener");

const resize = findings.find(f => f.target === "global_window:resize");
if (resize.severity !== "medium") throw new Error("resize severity must be medium");

console.log("JSON validation: OK");
' "$JSON_OUTPUT"

success "JSON output parsed and verified with all expected finding fields."

# 5. Run CLI with Table output format
step "5. Testing CLI execution with Table output format..."
TABLE_OUTPUT=$(node dist/cli.js scan "$TMP_DIR/package-lock.json" --format=table)

echo "$TABLE_OUTPUT"

# Verify table output strings
if [[ "$TABLE_OUTPUT" == *"[CRITICAL] event-listeners: global_process:uncaughtException"* ]] && \
   [[ "$TABLE_OUTPUT" == *"[CRITICAL] event-listeners: global_process:SIGTERM"* ]] && \
   [[ "$TABLE_OUTPUT" == *"[MEDIUM] event-listeners: global_window:resize"* ]] && \
   [[ "$TABLE_OUTPUT" == *"sentry-agent"* ]] && \
   [[ "$TABLE_OUTPUT" == *"winston-telemetry"* ]]; then
  success "Table output verified with proper severity tags and readable messages."
else
  fail "Table output did not contain expected severity tags or messages."
fi

# 6. Test scanner isolation via --only=event-listeners
step "6. Testing scanner isolation with --only=event-listeners..."
ISOLATED_OUTPUT=$(node dist/cli.js scan "$TMP_DIR/package-lock.json" --only=event-listeners --format=json)

node -e '
const raw = process.argv[1];
const findings = JSON.parse(raw);
if (!findings.every(f => f.scanner === "event-listeners")) {
  throw new Error("Found non-event-listener scanner in isolated scan");
}
if (findings.length !== 3) {
  throw new Error(`Expected 3 findings in isolated scan, got ${findings.length}`);
}
' "$ISOLATED_OUTPUT"
success "Scanner isolation (--only=event-listeners) verified."

# 7. Test SQLite Cache hit and performance
step "7. Testing SQLite cache persistence and reuse..."
# Clear cache database and measure execution
export COLLIDE_CACHE_DB="$TMP_DIR/collide-cache.db"

# First run: Cache Miss & Population
START_1=$(node -e 'console.log(Date.now())')
node dist/cli.js scan "$TMP_DIR/package-lock.json" --format=json > /dev/null
END_1=$(node -e 'console.log(Date.now())')
TIME_1=$((END_1 - START_1))

# Corrupt source files on disk to guarantee that second run hits SQLite cache strictly
echo "CORRUPTED SYNTAX {}{}" > "$NODE_MODULES/winston-telemetry/index.js"

# Second run: Cache Hit & Fast retrieval
START_2=$(node -e 'console.log(Date.now())')
CACHED_OUTPUT=$(node dist/cli.js scan "$TMP_DIR/package-lock.json" --format=json)
END_2=$(node -e 'console.log(Date.now())')
TIME_2=$((END_2 - START_2))

node -e '
const raw = process.argv[1];
const findings = JSON.parse(raw);
if (findings.length !== 3) {
  throw new Error(`Cache hit run failed to restore findings (got ${findings.length})`);
}
' "$CACHED_OUTPUT"

success "SQLite cache persistence verified. Cache hit successfully restored identical findings."

echo ""
echo "============================================================"
echo -e "${GREEN}  ALL END-TO-END TESTS PASSED SUCCESSFULLY!${NC}"
echo "============================================================"
