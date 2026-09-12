<div align="center">
  <h1>💥 Collide</h1>
  <p><strong>The Pluggable Dependency-Collision Scanner</strong></p>
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
  [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](http://makeapullrequest.com)

  <p>
    <a href="#features">Features</a> •
    <a href="#installation">Installation</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#updating">Updating</a> •
    <a href="#architecture">Architecture</a> •
    <a href="#contributing">Contributing</a>
  </p>
</div>

---

## 🌟 Overview

Modern projects pull in thousands of transitive dependencies. **Collide** opens the black box of your dependency tree. It doesn't just look at versions—it analyzes the AST (Abstract Syntax Tree) to catch dangerous state mutations, colliding event listeners, and OSV vulnerabilities before they hit production. 

Designed to be **blazing fast** and **infinitely extensible**, Collide uses a single core engine with interchangeable, pluggable scanner modules.

## ✨ Features

- **🌐 Multi-Ecosystem Support**: Works seamlessly with `npm` (Node.js), `Go` (go.sum), `Python` (pip/poetry/Pipfile), `Cargo` (Rust), and `Composer` (PHP).
- **🧩 Pluggable Scanners**: 4 built-in scanners (`osv`, `global-state`, `event-listeners`, `version-conflict`). Adding a new one requires zero core changes.
- **⚡ Smart SQLite Caching**: AST extraction is expensive. Collide caches package profiles in a local SQLite database, making subsequent runs lightning fast.
- **🤖 Agent/MCP Ready**: Generate rich table reports for humans, or structured `--format=json` outputs for MCPs and AI agents.
- **📦 Shared AST Walks**: Multiple scanners piggyback on a single AST traversal, maximizing efficiency.

---

## 🚀 Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm` or `yarn`

### Setup

Since Collide is preparing for its open-source release, you can currently install it directly from the source:

```bash
# 1. Clone the repository
git clone https://github.com/your-org/collide.git
cd collide/collide # Navigate to the core codebase

# 2. Install dependencies
npm install

# 3. Build the project
npm run build

# 4. Link globally (Optional, but recommended)
npm link
```

> [!TIP]
> Once linked globally, you can run the `collide` command from anywhere on your system to scan your projects!

---

## 🔄 Updating

To ensure you have the latest scanners and bug fixes, updating is just as simple:

```bash
# Pull the latest changes from the repository
git pull origin main

# Navigate to the collide directory (if not already there)
cd collide

# Reinstall dependencies and rebuild
npm install
npm run build
```

---

## 🛠️ Quick Start

Run Collide against any supported manifest file. The ecosystem is automatically detected!

### Basic Scan
Scan a project using all 4 default scanners:

```bash
collide scan ./package-lock.json
```

### Targeted Scans
Only care about vulnerabilities and version conflicts? Use the `--only` flag:

```bash
collide scan ./package-lock.json --only=osv,version-conflict
```

### JSON Output (For CI/CD & AI Agents)
Easily pipe findings into other tools using the JSON formatter:

```bash
collide scan ./requirements.txt --format=json
```

### Try the Built-in Demos!
Want to see Collide in action without scanning your own projects? We've included sandbox environments:
```bash
npm run demo         # Test against a vulnerable npm project
npm run go-demo      # Test against a Go module
npm run pip-demo     # Test against a Python environment
npm run cargo-demo   # Test against a Rust Cargo project
```

---

## 🔍 The Built-in Scanners

Collide ships with four powerful scanners out of the box:

1. **`osv` (Network)**: Batch-queries the OSV database to detect known vulnerabilities in your exact dependency tree.
2. **`version-conflict` (Tree)**: Analyzes your lockfile to flag multiple versions of the same dependency, helping you deduplicate your bundle.
3. **`global-state` (AST)**: Reads the package source code to detect dangerous global mutations or prototype pollution (e.g., `Array.prototype.flat = ...`).
4. **`event-listeners` (AST)**: Scans for aggressively registered global event listeners that could collide or cause memory leaks.

---

## 🏗️ Architecture & Design

At its heart, Collide relies on a shared `Scanner` interface. The core engine never knows what a scanner is checking internally—it simply calls `.scan(packages)` and merges the resulting `Finding[]` arrays.

```typescript
interface Scanner {
  name: string;
  scan(resolvedPackages: ResolvedPackage[]): Promise<Finding[]>;
}
```

For a deep dive into the underlying architecture, shared AST extractors, and how to write your own custom scanner in under 50 lines of code, read our [Complete Design Document](./design.md).

---

## 🤝 Contributing

We welcome contributions from the open-source community! Whether you want to add a new ecosystem parser, write a custom scanner (like a license-conflict checker), or optimize the SQLite cache, your PRs are appreciated.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingScanner`)
3. Commit your changes (`git commit -m 'Add AmazingScanner'`)
4. Push to the branch (`git push origin feature/AmazingScanner`)
5. Open a Pull Request

---

<div align="center">
  <p>Built with ❤️ for secure and stable software ecosystems.</p>
</div>
