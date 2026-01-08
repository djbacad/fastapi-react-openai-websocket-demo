$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"

if (-not (Test-Path $backendDir)) {
  throw "Backend folder not found at: $backendDir"
}

Set-Location $backendDir

$activateScript = Join-Path $backendDir ".venv\\Scripts\\Activate.ps1"
if (Test-Path $activateScript) {
  . $activateScript
} else {
  Write-Warning "Virtualenv not found at backend\\.venv. Continuing without activation."
}

Write-Host "Starting FastAPI backend on http://localhost:8000 ..." -ForegroundColor Cyan
python -m uvicorn main:app --reload --port 8000

