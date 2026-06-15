# One-time setup: backend venv + dependencies, frontend dependencies, .env scaffold.
# Safe to re-run - never overwrites an existing apps\api\.env.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # scripts\.. = repo root

# Run a native exe and fail ONLY on a non-zero exit code. Under
# $ErrorActionPreference='Stop', PowerShell 5.1 otherwise treats a native command's
# stderr (e.g. npm/pip deprecation warnings) as a fatal error even when it exits 0 -
# especially when the script's output is captured/redirected.
function Invoke-Step {
  param([Parameter(Mandatory)][string]$File, [string[]]$CmdArgs = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $File @CmdArgs } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "'$File $($CmdArgs -join ' ')' failed (exit $LASTEXITCODE)" }
}

# 1. Pick a Python interpreter (3.11+ required).
$py = $null
foreach ($c in @("python", "python3")) {
  if (Get-Command $c -ErrorAction SilentlyContinue) { $py = $c; break }
}
if (-not $py) { Write-Error "Python 3.11+ not found on PATH"; exit 1 }

Write-Host "==> backend: creating venv with $py"
Set-Location "$root\apps\api"
Invoke-Step $py @("-m", "venv", "venv")
Invoke-Step ".\venv\Scripts\python.exe" @("-m", "pip", "install", "--quiet", "--upgrade", "pip")
Write-Host "==> backend: installing requirements (this takes a few minutes)"
Invoke-Step ".\venv\Scripts\python.exe" @("-m", "pip", "install", "--quiet", "-r", "requirements.txt")

# 2. Scaffold apps\api\.env from the example (never clobber an existing one).
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "==> backend: created apps\api\.env - add OPENAI_API_KEY + E2B_API_KEY (or Bedrock keys)"
} else {
  Write-Host "==> backend: apps\api\.env already exists - left untouched"
}

# 3. Frontend env + dependencies.
Set-Location "$root\apps\web"
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "==> frontend: created apps\web\.env (points the web app at the local backend)"
} else {
  Write-Host "==> frontend: apps\web\.env already exists - left untouched"
}
Write-Host "==> frontend: npm install"
Invoke-Step "npm.cmd" @("install")

Write-Host ""
Write-Host "Setup complete. Edit apps\api\.env with your keys, then run:  .\scripts\dev.ps1"
