# Start the backend (apps\api) and frontend (apps\web) together.
# Press Ctrl+C once to stop both. Run .\scripts\setup.ps1 first.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$py = "$root\apps\api\venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Error "backend venv missing - run .\scripts\setup.ps1 first"; exit 1 }

# Explicit local dev mode: makes the backend load apps\api\.env (FLOOM_DB + creds).
# Without it a fresh clone has no .env loaded, so auth collapses every session to
# the 'federico' dev default and no provider keys are picked up.
$env:WORKEROS_DEV = "1"

$procs = @()
try {
  Write-Host "==> backend  -> http://localhost:8000"
  $procs += Start-Process -FilePath $py -ArgumentList "main.py" `
    -WorkingDirectory "$root\apps\api" -NoNewWindow -PassThru

  Write-Host "==> frontend -> http://localhost:3000"
  $procs += Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" `
    -WorkingDirectory "$root\apps\web" -NoNewWindow -PassThru

  Write-Host "Both running. Press Ctrl+C to stop."
  while ($true) {
    Start-Sleep -Seconds 1
    if ($procs | Where-Object { $_.HasExited }) { break }
  }
} finally {
  Write-Host "`nstopping..."
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) {
      # /T kills the whole process tree: uvicorn's reload watcher and Next.js both spawn children.
      taskkill /PID $p.Id /T /F 2>$null | Out-Null
    }
  }
}
