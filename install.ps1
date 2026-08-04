# devmap installer (PowerShell) — pulls from the official source (npm registry / PyPI).
# Run in an elevated PowerShell if the global npm install needs admin rights.
#
# Primary channel: npm (ships the real Node-runnable bundle).
# PyPI package is a thin wrapper that still requires Node at runtime,
# used only as a fallback when npm is unavailable.
$ErrorActionPreference = "Stop"

Write-Host "==> Installing devmap (official source)..."

$npm = Get-Command npm -ErrorAction SilentlyContinue
$pip = Get-Command pip -ErrorAction SilentlyContinue

if ($npm) {
    Write-Host "    Found npm - installing devmap globally via npm (real bundle)"
    # Pin to the official registry; drop --registry to respect a local mirror.
    & npm install -g devmap --registry=https://registry.npmjs.org/
} elseif ($pip) {
    Write-Host "    npm not found - installing via pip (requires Node at runtime)"
    & python -m pip install --user devmap
} else {
    Write-Error "Neither npm nor pip is available. Install Node.js first: https://nodejs.org"
    exit 1
}

Write-Host "==> Verifying..."
if (Get-Command devmap -ErrorAction SilentlyContinue) {
    try { devmap --version } catch { try { devmap --help } catch { $null } }
    Write-Host "==> Done. Try: devmap scan"
} else {
    Write-Host "==> Installed, but 'devmap' is not on PATH. Restart your shell or run the global bin dir directly."
}
