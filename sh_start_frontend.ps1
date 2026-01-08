$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$frontendDir = Join-Path $repoRoot "frontend"

if (-not (Test-Path $frontendDir)) {
  throw "Frontend folder not found at: $frontendDir"
}

Set-Location $frontendDir

if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
  Write-Host "node_modules not found. Installing dependencies..." -ForegroundColor Yellow
  npm install
}

if (-not $env:VITE_API_BASE_URL) {
  $env:VITE_API_BASE_URL = "http://localhost:8000"
}

Write-Host "Starting Vite frontend on http://localhost:5173 (API: $env:VITE_API_BASE_URL) ..." -ForegroundColor Cyan
npm run dev

