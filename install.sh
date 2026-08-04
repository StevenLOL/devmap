#!/usr/bin/env bash
# devmap installer — pulls from the official source (npm registry / PyPI).
# Cross-platform: works on Linux, macOS, Git Bash and WSL.
#
# The primary channel is npm (ships the real Node-runnable bundle).
# The PyPI package is a thin wrapper that still requires Node at runtime,
# so it is only used as a fallback when npm is unavailable.
set -euo pipefail

echo "==> Installing devmap (official source)..."

if command -v npm >/dev/null 2>&1; then
  echo "    Found npm — installing devmap globally via npm (real bundle)"
  # Pin to the official registry; drop --registry to respect a local mirror.
  npm install -g devmap --registry=https://registry.npmjs.org/
elif command -v pip3 >/dev/null 2>&1; then
  echo "    npm not found — installing via pip (requires Node at runtime)"
  pip3 install --user devmap
elif command -v pip >/dev/null 2>&1; then
  echo "    npm not found — installing via pip (requires Node at runtime)"
  pip install --user devmap
else
  echo "    ERROR: neither npm nor pip is available." >&2
  echo "    Install Node.js first: https://nodejs.org (then re-run this script)" >&2
  exit 1
fi

echo "==> Verifying..."
if command -v devmap >/dev/null 2>&1; then
  devmap --version 2>/dev/null || devmap --help >/dev/null 2>&1 || true
  echo "==> Done. Try: devmap scan"
else
  echo "==> Installed, but 'devmap' is not on PATH."
  echo "    Restart your shell, or run the global bin dir directly."
fi
