# PowerShell Worker Launcher for Windows
$Host.UI.RawUI.WindowTitle = "Local Worker - ee-auto"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Local Worker for ee-auto.up.railway.app (PowerShell)  " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not found in PATH!" -ForegroundColor Red
    Write-Host "Please install Node.js 20 or higher from https://nodejs.org/"
    Read-Host "Press Enter to exit..."
    exit 1
}

# Check .env
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Write-Host "[INFO] Copying .env.example to .env..." -ForegroundColor Yellow
        Copy-Item ".env.example" ".env"
        Write-Host "[INFO] Created .env file. Please edit it with your desired settings." -ForegroundColor Green
    }
}

Write-Host "Starting worker loop... (Press Ctrl+C to stop)`n" -ForegroundColor Green

while ($true) {
    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$now] Launching node worker.mjs..." -ForegroundColor Cyan
    & node worker.mjs
    $code = $LASTEXITCODE
    $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$now] Worker process exited with code $code. Restarting in 5s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
