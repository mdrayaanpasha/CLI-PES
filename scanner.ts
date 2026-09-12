#!/usr/bin/env node

/**
 * Dependency, Security, and Version Conflict Scanner for Node.js Projects
 * 
 * Features:
 *  1. Vulnerability Audit Scanner (npm, yarn, pnpm, bun)
 *  2. Top-Level Dependency Breakdown (what each direct dependency brings in)
 *  3. Reverse Lookup Guidance (npm explain / yarn why / pnpm why)
 *  4. Deep Dependency Relationships & Single-Package Inspection
 *  5. Global Version Conflict Identifier & End Report:
 *     - Scans entire graph across lockfiles and node_modules
 *     - Detects multi-version duplicates and incompatible semver requirements
 *     - Generates an executive final scorecard with remediation actions
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ============================================================================
// 1. Interfaces & Types
// ============================================================================

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface DependencyUsage {
  dependentName: string;       // Package that declared this dependency (e.g. "express" or "[Root]")
  dependentVersion?: string;   // Version of the parent package
  requestedRange: string;      // Semver range requested by the parent (e.g. "^4.17.21")
  resolvedVersion?: string;    // Actual installed version found
}

export interface PackageNode {
  name: string;
  installedVersions: Set<string>;
  dependencies: Map<string, string>; // What this package requires: name -> range
  requiredBy: DependencyUsage[];      // Who requires this package
}

export type ConflictSeverity = 'CRITICAL' | 'WARNING';

export interface VersionConflict {
  packageName: string;
  severity: ConflictSeverity;
  installedVersions: string[];
  requestedRanges: string[];
  requestedBy: DependencyUsage[];
  cause: string;
  remediation: string;
}

export interface ConflictAuditResult {
  totalPackagesScanned: number;
  cleanPackagesCount: number;
  conflictingPackagesCount: number;
  conflicts: VersionConflict[];
  packageMap: Map<string, PackageNode>;
}

// ============================================================================
// 2. Color & Formatting Utilities
// ============================================================================

export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

export const fmt = {
  bold: (t: string | number) => `${colors.bold}${t}${colors.reset}`,
  dim: (t: string | number) => `${colors.dim}${t}${colors.reset}`,
  green: (t: string | number) => `${colors.green}${t}${colors.reset}`,
  yellow: (t: string | number) => `${colors.yellow}${t}${colors.reset}`,
  red: (t: string | number) => `${colors.red}${t}${colors.reset}`,
  cyan: (t: string | number) => `${colors.cyan}${t}${colors.reset}`,
  magenta: (t: string | number) => `${colors.magenta}${t}${colors.reset}`,
};

export function logHeader(text: string): void {
  console.log(`\n${colors.bold}${colors.cyan}=== ${text} ===${colors.reset}\n`);
}

// ============================================================================
// 3. Package Manager & File Utilities
// ============================================================================

export function detectPackageManager(projectRoot: string): PackageManager {
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (
    fs.existsSync(path.join(projectRoot, 'bun.lockb')) ||
    fs.existsSync(path.join(projectRoot, 'bun.lock'))
  ) {
    return 'bun';
  }
  return 'npm';
}

export function readPackageJson(filePath: string): PackageJson | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

// ============================================================================
// 4. Task 1: Security Audit Scan
// ============================================================================

export function runSecurityAudit(packageManager: PackageManager): void {
  logHeader('1. RUNNING VULNERABILITY AUDIT SCAN');
  try {
    let auditCmd = 'npm audit';
    if (packageManager === 'yarn') auditCmd = 'yarn audit';
    if (packageManager === 'pnpm') auditCmd = 'pnpm audit';
    if (packageManager === 'bun') auditCmd = 'bun pm audit';

    console.log(`Running \`${auditCmd}\`...`);
    execSync(auditCmd, { stdio: 'inherit' });
    console.log(`\n${fmt.green(fmt.bold('✔ No known vulnerabilities found!'))}`);
  } catch {
    console.log(`\n${fmt.yellow('⚠️  Audit completed. Review the vulnerabilities listed above.')}`);
  }
}

// ============================================================================
// 5. Task 2: Top-Level Dependency Breakdown
// ============================================================================

export function inspectTopLevelDependencies(projectRoot: string, allTopLevel: string[]): void {
  logHeader('2. TOP-LEVEL DEPENDENCY BREAKDOWN (WHAT THEY BRING IN)');
  console.log(`${fmt.dim('Reading locally installed packages from node_modules...')}\n`);

  for (const depName of allTopLevel) {
    try {
      const depPkgPath = path.join(projectRoot, 'node_modules', depName, 'package.json');
      if (fs.existsSync(depPkgPath)) {
        const depPkg = readPackageJson(depPkgPath);
        if (!depPkg) throw new Error('Invalid package.json');

        const subDeps = Object.keys(depPkg.dependencies || {});
        const count = subDeps.length;
        const countStr = count === 0
          ? `${fmt.green('0 sub-dependencies')}`
          : `${fmt.yellow(`${count} sub-dependencies`)}`;

        console.log(`📦 ${fmt.bold(depName)} (v${depPkg.version || 'unknown'}) -> relies on ${countStr}`);

        if (count > 0) {
          const maxToShow = 5;
          const displayDeps = subDeps.slice(0, maxToShow).map(d => fmt.dim(d));
          if (subDeps.length > maxToShow) {
            displayDeps.push(fmt.dim(`...and ${subDeps.length - maxToShow} more`));
          }
          console.log(`   └── ${displayDeps.join(', ')}`);
        }
      } else {
        console.log(`📦 ${fmt.bold(depName)} -> ${fmt.red('Not locally installed (run installation first)')}`);
      }
    } catch {
      console.log(`📦 ${fmt.bold(depName)} -> ${fmt.red('Error reading sub-dependencies')}`);
    }
  }
}

// ============================================================================
// 6. Task 3: Reverse Lookup Guidance
// ============================================================================

export function printReverseLookupHelp(packageManager: PackageManager): void {
  logHeader('3. REVERSE LOOKUP TOOL');
  console.log('To run a live interactive reverse lookup on any deep sub-dependency, run:');
  if (packageManager === 'npm') console.log(`   ${fmt.bold('npm explain <package-name>')}`);
  if (packageManager === 'yarn') console.log(`   ${fmt.bold('yarn why <package-name>')}`);
  if (packageManager === 'pnpm') console.log(`   ${fmt.bold('pnpm why <package-name>')}`);
  if (packageManager === 'bun') console.log(`   ${fmt.bold('bun pm whoami <package-name> (or inspect bun.lockb)')}`);
  console.log('');
}

// ============================================================================
// 7. Global Dependency Tree Builder
// ============================================================================

export function buildDependencyGraph(projectRoot: string): Map<string, PackageNode> {
  const packageMap = new Map<string, PackageNode>();

  function getOrCreateNode(name: string): PackageNode {
    let node = packageMap.get(name);
    if (!node) {
      node = {
        name,
        installedVersions: new Set<string>(),
        dependencies: new Map<string, string>(),
        requiredBy: [],
      };
      packageMap.set(name, node);
    }
    return node;
  }

  // 1. Root package.json
  const rootPkg = readPackageJson(path.join(projectRoot, 'package.json'));
  if (rootPkg) {
    const directDeps = {
      ...(rootPkg.dependencies || {}),
      ...(rootPkg.devDependencies || {}),
    };
    for (const [dep, range] of Object.entries(directDeps)) {
      const node = getOrCreateNode(dep);
      node.requiredBy.push({
        dependentName: `[Root: ${rootPkg.name || 'project'}]`,
        dependentVersion: rootPkg.version || '1.0.0',
        requestedRange: String(range),
      });
    }
  }

  // 2. package-lock.json (if present)
  const lockfilePath = path.join(projectRoot, 'package-lock.json');
  if (fs.existsSync(lockfilePath)) {
    try {
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      if (lockfile.packages && typeof lockfile.packages === 'object') {
        for (const [lockPath, entry] of Object.entries<any>(lockfile.packages)) {
          if (!lockPath) continue;
          
          const parts = lockPath.split('node_modules/').filter(Boolean);
          const pkgName = parts[parts.length - 1]?.replace(/\/$/, '');
          const parentName = parts.length > 1
            ? parts[parts.length - 2]?.replace(/\/$/, '')
            : `[Root: ${rootPkg?.name || 'project'}]`;

          if (!pkgName) continue;
          const node = getOrCreateNode(pkgName);
          if (entry.version) node.installedVersions.add(entry.version);

          if (entry.dependencies && typeof entry.dependencies === 'object') {
            for (const [depName, range] of Object.entries(entry.dependencies)) {
              node.dependencies.set(depName, String(range));
              const childNode = getOrCreateNode(depName);
              childNode.requiredBy.push({
                dependentName: pkgName,
                dependentVersion: entry.version,
                requestedRange: String(range),
                resolvedVersion: entry.version,
              });
            }
          }
        }
      }
    } catch {}
  }

  // 3. node_modules on disk (detects nested isolated duplicates)
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    function walkModules(dir: string, parentName: string, parentVer?: string): void {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

          if (entry.name.startsWith('@')) {
            const scopeDir = path.join(dir, entry.name);
            const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
            for (const sub of scopedEntries) {
              if (sub.isDirectory()) {
                inspectPkgDir(path.join(scopeDir, sub.name), `${entry.name}/${sub.name}`, parentName, parentVer);
              }
            }
          } else {
            inspectPkgDir(path.join(dir, entry.name), entry.name, parentName, parentVer);
          }
        }
      } catch {}
    }

    function inspectPkgDir(pkgDir: string, pkgName: string, parentName: string, parentVer?: string): void {
      const pJson = readPackageJson(path.join(pkgDir, 'package.json'));
      if (pJson) {
        const node = getOrCreateNode(pkgName);
        if (pJson.version) node.installedVersions.add(pJson.version);

        if (pJson.dependencies) {
          for (const [depName, range] of Object.entries(pJson.dependencies)) {
            node.dependencies.set(depName, String(range));
            const childNode = getOrCreateNode(depName);
            const exists = childNode.requiredBy.some(
              r => r.dependentName === pkgName &&
                   r.dependentVersion === pJson.version &&
                   r.requestedRange === String(range)
            );
            if (!exists) {
              childNode.requiredBy.push({
                dependentName: pkgName,
                dependentVersion: pJson.version,
                requestedRange: String(range),
                resolvedVersion: pJson.version,
              });
            }
          }
        }

        const nestedDir = path.join(pkgDir, 'node_modules');
        if (fs.existsSync(nestedDir)) {
          walkModules(nestedDir, pkgName, pJson.version);
        }
      }
    }

    walkModules(nodeModulesPath, '[Root]');
  }

  return packageMap;
}

// ============================================================================
// 8. IDENTIFY VERSION CONFLICTS AMONG ALL PACKAGES
// ============================================================================

/**
 * Scans all packages in the dependency tree and identifies all version conflicts.
 * Checks for:
 *  - Multiple conflicting installed versions (e.g. lodash@3 vs lodash@4)
 *  - Incompatible major version requirements requested across parents
 */
export function identifyAllVersionConflicts(projectRoot: string): ConflictAuditResult {
  const packageMap = buildDependencyGraph(projectRoot);
  const conflicts: VersionConflict[] = [];

  for (const [name, node] of packageMap.entries()) {
    const installedList = Array.from(node.installedVersions);
    const ranges = Array.from(new Set(node.requiredBy.map(r => r.requestedRange)));

    // Condition 1: Multiple distinct versions installed simultaneously
    if (installedList.length > 1) {
      conflicts.push({
        packageName: name,
        severity: 'CRITICAL',
        installedVersions: installedList,
        requestedRanges: ranges,
        requestedBy: node.requiredBy,
        cause: `${installedList.length} different versions (${installedList.join(', ')}) are co-existing in the dependency tree (duplicate singleton/bundle bloat).`,
        remediation: `Run \`npm dedupe\` or check if parent packages can be updated to share a single version of "${name}".`,
      });
      continue;
    }

    // Condition 2: Incompatible major version ranges requested by different dependents
    if (ranges.length > 1) {
      const majorVersions = new Set<string>();
      for (const r of ranges) {
        const match = r.match(/\b(\d+)\./);
        if (match) majorVersions.add(match[1]);
      }
      if (majorVersions.size > 1) {
        conflicts.push({
          packageName: name,
          severity: 'WARNING',
          installedVersions: installedList,
          requestedRanges: ranges,
          requestedBy: node.requiredBy,
          cause: `Incompatible major version specifiers requested by parents: ${ranges.join(', ')} (Resolved: ${installedList[0] ? 'v' + installedList[0] : 'unresolved'}).`,
          remediation: `Align version requirements across dependencies using package.json "overrides" or updating outdated dependents.`,
        });
      }
    }
  }

  return {
    totalPackagesScanned: packageMap.size,
    cleanPackagesCount: packageMap.size - conflicts.length,
    conflictingPackagesCount: conflicts.length,
    conflicts,
    packageMap,
  };
}

// ============================================================================
// 9. Single-Package Deep Dive Inspection (Task 4)
// ============================================================================

export function inspectPackageDetails(summary: ConflictAuditResult, targetPackage: string): void {
  logHeader(`4. PACKAGE DEEP-DIVE: ${targetPackage}`);
  const node = summary.packageMap.get(targetPackage);

  if (!node) {
    console.log(`${fmt.yellow('ℹ')} Package "${targetPackage}" was not found in the dependency graph.`);
    return;
  }

  const versions = Array.from(node.installedVersions);
  const conflict = summary.conflicts.find(c => c.packageName === targetPackage);

  console.log(`📦 ${fmt.bold(targetPackage)}`);
  console.log(`   ${fmt.bold('Installed Version(s):')} ${versions.length > 0 ? versions.map(v => fmt.green('v' + v)).join(', ') : fmt.red('Not installed')}`);
  console.log(`   ${fmt.bold('Conflict Status:')}      ${conflict ? fmt.red(`⚠️  CONFLICT: ${conflict.cause}`) : fmt.green('✔ No conflict detected')}`);

  console.log(`\n   ${fmt.cyan(fmt.bold('Who depends on it (Dependents):'))}`);
  if (node.requiredBy.length === 0) {
    console.log(`     ${fmt.dim('(No parent packages require this directly)')}`);
  } else {
    for (const dep of node.requiredBy) {
      const verTag = dep.dependentVersion ? ` (v${dep.dependentVersion})` : '';
      console.log(`     ├─ ${fmt.bold(dep.dependentName)}${verTag} -> requires ${fmt.yellow(dep.requestedRange)}`);
    }
  }

  console.log(`\n   ${fmt.cyan(fmt.bold('What it depends on (Direct sub-dependencies):'))}`);
  if (node.dependencies.size === 0) {
    console.log(`     ${fmt.dim('(None — 0 dependencies)')}`);
  } else {
    for (const [childName, range] of node.dependencies.entries()) {
      const childNode = summary.packageMap.get(childName);
      const childVer = childNode && childNode.installedVersions.size > 0
        ? `[installed: ${Array.from(childNode.installedVersions).map(v => 'v' + v).join(', ')}]`
        : '[not installed]';
      console.log(`     ├─ ${fmt.bold(childName)}: requires ${fmt.yellow(range)} ${fmt.dim(childVer)}`);
    }
  }
  console.log('');
}

// ============================================================================
// 10. FINAL END REPORT: VERSION CONFLICT AUDIT
// ============================================================================

/**
 * Appends the final summary scorecard and conflict breakdown to the end of the report.
 */
export function renderConflictEndReport(audit: ConflictAuditResult): void {
  const border = '='.repeat(72);
  const divider = '-'.repeat(72);

  console.log(`\n${colors.bold}${colors.cyan}${border}${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}             📊 END REPORT: VERSION CONFLICT AUDIT${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}${border}${colors.reset}`);

  if (audit.conflictingPackagesCount === 0) {
    console.log(`  ${fmt.green(fmt.bold('✔ HEALTH STATUS: EXCELLENT (0 Conflicts Detected)'))}`);
    console.log(`  Scanned ${fmt.bold(audit.totalPackagesScanned)} packages across the dependency tree.`);
    console.log(`  Every dependency resolves to a consistent, non-colliding version!`);
    console.log(`${colors.bold}${colors.cyan}${border}${colors.reset}\n`);
    return;
  }

  console.log(`  ${fmt.yellow(fmt.bold(`⚠️  HEALTH STATUS: ACTION RECOMMENDED (${audit.conflictingPackagesCount} Conflict${audit.conflictingPackagesCount > 1 ? 's' : ''} Detected)`))}`);
  console.log(`  Total Packages: ${fmt.bold(audit.totalPackagesScanned)}  |  Clean: ${fmt.green(fmt.bold(audit.cleanPackagesCount))}  |  Conflicting: ${fmt.red(fmt.bold(audit.conflictingPackagesCount))}`);
  console.log(`\n${divider}`);
  console.log(`  ${fmt.bold('CONFLICT BREAKDOWN:')}`);

  audit.conflicts.forEach((c, idx) => {
    const badge = c.severity === 'CRITICAL'
      ? `${colors.red}${colors.bold}[CRITICAL DUPLICATE]${colors.reset}`
      : `${colors.yellow}${colors.bold}[VERSION MISMATCH]${colors.reset}`;

    console.log(`\n  ${idx + 1}. Package: ${fmt.bold(c.packageName)} ${badge}`);
    console.log(`     • ${fmt.dim('Installed Versions:')} ${c.installedVersions.map(v => fmt.bold('v' + v)).join(', ') || fmt.dim('(unresolved)')}`);
    console.log(`     • ${fmt.dim('Issue Description:')}  ${c.cause}`);
    console.log(`     • ${fmt.cyan('Required By (Dependents):')}`);

    c.requestedBy.forEach((req, rIdx) => {
      const isLast = rIdx === c.requestedBy.length - 1;
      const prefix = isLast ? '       └──' : '       ├──';
      const verStr = req.dependentVersion ? ` (v${req.dependentVersion})` : '';
      console.log(` ${prefix} ${fmt.bold(req.dependentName)}${verStr} -> requires ${fmt.yellow(req.requestedRange)}`);
    });

    console.log(`     • ${fmt.green('Remediation:')}        ${c.remediation}`);
  });

  console.log(`\n${divider}`);
  console.log(`  ${fmt.bold('💡 RECOMMENDED REMEDIATION ACTIONS:')}`);
  console.log(`   1. Run \`npm dedupe\` (or \`yarn dedupe\` / \`pnpm dedupe\`) to flatten identical packages.`);
  console.log(`   2. Run \`npm explain <package-name>\` to trace exact ancestry chains.`);
  console.log(`   3. Add an \`"overrides"\` block to package.json to force a single version if needed.`);
  console.log(`${colors.bold}${colors.cyan}${border}${colors.reset}\n`);
}

// ============================================================================
// 11. Main CLI Runner
// ============================================================================

export function main(): void {
  const projectRoot = process.cwd();
  const packageJsonPath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    console.error(`${fmt.red(fmt.bold('Error:'))} package.json not found in current directory (${projectRoot}).`);
    console.error('Please run this script inside the root directory of a Node.js project.');
    process.exit(1);
  }

  const packageManager = detectPackageManager(projectRoot);
  const pkg = readPackageJson(packageJsonPath);

  if (!pkg) {
    console.error(`${fmt.red(fmt.bold('Error:'))} Unable to parse package.json.`);
    process.exit(1);
  }

  const topLevelDeps = Object.keys(pkg.dependencies || {});
  const topLevelDevDeps = Object.keys(pkg.devDependencies || {});
  const allTopLevel = [...topLevelDeps, ...topLevelDevDeps];

  console.log(`${fmt.bold('Project:')}                  ${pkg.name || 'Unnamed'} (v${pkg.version || '1.0.0'})`);
  console.log(`${fmt.bold('Detected Package Manager:')} ${fmt.green(packageManager)}`);
  console.log(`${fmt.bold('Total Top-Level Deps:')}     ${allTopLevel.length}`);

  if (allTopLevel.length === 0) {
    console.log(`\n${fmt.yellow('No dependencies found to scan. Add some dependencies first!')}`);
    process.exit(0);
  }

  const args = process.argv.slice(2);
  const targetPackageArg = args.find(a => !a.startsWith('-'));

  // Task 1: Vulnerability Audit
  runSecurityAudit(packageManager);

  // Task 2: Top-Level Breakdown
  inspectTopLevelDependencies(projectRoot, allTopLevel);

  // Task 3: Reverse Lookup Guidance
  printReverseLookupHelp(packageManager);

  // Identify Version Conflicts Across ALL Packages
  const conflictAudit = identifyAllVersionConflicts(projectRoot);

  // Task 4: If single package was requested, show deep-dive
  if (targetPackageArg) {
    inspectPackageDetails(conflictAudit, targetPackageArg);
  }

  // Task 5: Final End Report
  renderConflictEndReport(conflictAudit);
}

// Run if invoked directly
if (process.argv[1] && (process.argv[1].endsWith('scanner.ts') || process.argv[1].endsWith('scanner.js'))) {
  main();
}
