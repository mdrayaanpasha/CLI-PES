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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. Color utilities for terminal formatting
const colors = {
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

const fmt = {
  bold: (t) => `${colors.bold}${t}${colors.reset}`,
  dim: (t) => `${colors.dim}${t}${colors.reset}`,
  green: (t) => `${colors.green}${t}${colors.reset}`,
  yellow: (t) => `${colors.yellow}${t}${colors.reset}`,
  red: (t) => `${colors.red}${t}${colors.reset}`,
  cyan: (t) => `${colors.cyan}${t}${colors.reset}`,
  magenta: (t) => `${colors.magenta}${t}${colors.reset}`,
};

function logHeader(text) {
  console.log(`\n${colors.bold}${colors.cyan}=== ${text} ===${colors.reset}\n`);
}

// 2. Locate package.json and lockfiles
const projectRoot = process.cwd();
const packageJsonPath = path.join(projectRoot, 'package.json');

if (!fs.existsSync(packageJsonPath)) {
  console.error(`${fmt.red(fmt.bold('Error:'))} package.json not found in the current directory (${projectRoot}).`);
  console.error('Please run this script inside the root directory of a Node.js project.');
  process.exit(1);
}

function readPackageJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// 3. Detect package manager based on lockfiles
let packageManager = 'npm';
if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
  packageManager = 'yarn';
} else if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
  packageManager = 'pnpm';
} else if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) {
  packageManager = 'bun';
}

// Read top-level dependencies
const pkg = readPackageJson(packageJsonPath) || {};
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

// Optional target package argument
const targetPackageArg = process.argv.slice(2).find(a => !a.startsWith('-'));

// --- TASK 1: RUN SECURITY AUDIT ---
logHeader('1. RUNNING VULNERABILITY AUDIT SCAN');
try {
  let auditCmd = 'npm audit';
  if (packageManager === 'yarn') auditCmd = 'yarn audit';
  if (packageManager === 'pnpm') auditCmd = 'pnpm audit';
  if (packageManager === 'bun') auditCmd = 'bun pm audit';

  console.log(`Running \`${auditCmd}\`...`);
  execSync(auditCmd, { stdio: 'inherit' });
  console.log(`\n${fmt.green(fmt.bold('✔ No known vulnerabilities found!'))}`);
} catch (error) {
  console.log(`\n${fmt.yellow('⚠️  Audit completed. Review the vulnerabilities listed above.')}`);
}

// --- TASK 2: MAP TOP-LEVEL DEPENDENCY RETAINERS ---
logHeader('2. TOP-LEVEL DEPENDENCY BREAKDOWN (WHAT THEY BRING IN)');
console.log(`${fmt.dim('Reading locally installed packages from node_modules...')}\n`);

allTopLevel.forEach(depName => {
  try {
    const depPkgPath = path.join(projectRoot, 'node_modules', depName, 'package.json');
    if (fs.existsSync(depPkgPath)) {
      const depPkg = readPackageJson(depPkgPath);
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
  } catch (err) {
    console.log(`📦 ${fmt.bold(depName)} -> ${fmt.red('Error reading sub-dependencies')}`);
  }
});

// --- TASK 3: REVERSE LOOKUP TOOL ---
logHeader('3. REVERSE LOOKUP TOOL');
console.log('To run a live interactive reverse lookup on any deep sub-dependency, run:');
if (packageManager === 'npm') console.log(`   ${fmt.bold('npm explain <package-name>')}`);
if (packageManager === 'yarn') console.log(`   ${fmt.bold('yarn why <package-name>')}`);
if (packageManager === 'pnpm') console.log(`   ${fmt.bold('pnpm why <package-name>')}`);
if (packageManager === 'bun') console.log(`   ${fmt.bold('bun pm whoami <package-name> (or inspect bun.lockb)')}`);
console.log('');

// --- BUILD DEPENDENCY GRAPH ---
function buildDependencyGraph(rootPath) {
  const packageMap = new Map();

  function getOrCreate(name) {
    let node = packageMap.get(name);
    if (!node) {
      node = {
        name,
        installedVersions: new Set(),
        dependencies: new Map(),
        requiredBy: [],
      };
      packageMap.set(name, node);
    }
    return node;
  }

  // 1. Root package.json
  const directDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  for (const [dep, range] of Object.entries(directDeps)) {
    const node = getOrCreate(dep);
    node.requiredBy.push({
      dependentName: `[Root: ${pkg.name || 'project'}]`,
      dependentVersion: pkg.version || '1.0.0',
      requestedRange: String(range),
    });
  }

  // 2. package-lock.json
  const lockfilePath = path.join(rootPath, 'package-lock.json');
  if (fs.existsSync(lockfilePath)) {
    try {
      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
      if (lockfile.packages && typeof lockfile.packages === 'object') {
        for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
          if (!lockPath) continue;
          const parts = lockPath.split('node_modules/').filter(Boolean);
          const pName = parts[parts.length - 1]?.replace(/\/$/, '');
          const parentName = parts.length > 1
            ? parts[parts.length - 2]?.replace(/\/$/, '')
            : `[Root: ${pkg.name || 'project'}]`;

          if (!pName) continue;
          const node = getOrCreate(pName);
          if (entry.version) node.installedVersions.add(entry.version);

          if (entry.dependencies && typeof entry.dependencies === 'object') {
            for (const [depName, range] of Object.entries(entry.dependencies)) {
              node.dependencies.set(depName, String(range));
              const childNode = getOrCreate(depName);
              childNode.requiredBy.push({
                dependentName: pName,
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

  // 3. node_modules on disk
  const nodeModulesPath = path.join(rootPath, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) {
    function walkModules(dir, parentName, parentVer) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

          if (entry.name.startsWith('@')) {
            const scopeDir = path.join(dir, entry.name);
            const scoped = fs.readdirSync(scopeDir, { withFileTypes: true });
            for (const sub of scoped) {
              if (sub.isDirectory()) {
                inspectPkg(path.join(scopeDir, sub.name), `${entry.name}/${sub.name}`, parentName, parentVer);
              }
            }
          } else {
            inspectPkg(path.join(dir, entry.name), entry.name, parentName, parentVer);
          }
        }
      } catch {}
    }

    function inspectPkg(pkgDir, pName, parentName, parentVer) {
      const pJson = readPackageJson(path.join(pkgDir, 'package.json'));
      if (pJson) {
        const node = getOrCreate(pName);
        if (pJson.version) node.installedVersions.add(pJson.version);

        if (pJson.dependencies) {
          for (const [depName, range] of Object.entries(pJson.dependencies)) {
            node.dependencies.set(depName, String(range));
            const childNode = getOrCreate(depName);
            const exists = childNode.requiredBy.some(
              r => r.dependentName === pName &&
                   r.dependentVersion === pJson.version &&
                   r.requestedRange === String(range)
            );
            if (!exists) {
              childNode.requiredBy.push({
                dependentName: pName,
                dependentVersion: pJson.version,
                requestedRange: String(range),
                resolvedVersion: pJson.version,
              });
            }
          }
        }

        const nestedDir = path.join(pkgDir, 'node_modules');
        if (fs.existsSync(nestedDir)) {
          walkModules(nestedDir, pName, pJson.version);
        }
      }
    }

    walkModules(nodeModulesPath, '[Root]');
  }

  return packageMap;
}

// --- IDENTIFY VERSION CONFLICTS AMONG ALL PACKAGES ---
function identifyAllVersionConflicts(rootPath) {
  const packageMap = buildDependencyGraph(rootPath);
  const conflicts = [];

  for (const [name, node] of packageMap.entries()) {
    const installedList = Array.from(node.installedVersions);
    const ranges = Array.from(new Set(node.requiredBy.map(r => r.requestedRange)));

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

    if (ranges.length > 1) {
      const majorVersions = new Set();
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

// --- SINGLE-PACKAGE DEEP-DIVE (TASK 4) ---
function inspectPackageDetails(summary, targetPackage) {
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

// --- FINAL END REPORT: VERSION CONFLICT AUDIT (TASK 5) ---
function renderConflictEndReport(audit) {
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

// Execution
const conflictAudit = identifyAllVersionConflicts(projectRoot);

if (targetPackageArg) {
  inspectPackageDetails(conflictAudit, targetPackageArg);
}

renderConflictEndReport(conflictAudit);

module.exports = {
  identifyAllVersionConflicts,
  renderConflictEndReport,
  inspectPackageDetails,
};
