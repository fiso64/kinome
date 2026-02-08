# Kinome Handler Installer for Windows
# Usage: irm http://your-server/install-kinome-handler.ps1?secret=YOUR_SECRET | iex

# Note: Secret and BaseUrl are injected by the server at download time.

if (-not $Secret) {
    Write-Host "ERROR: No secret provided. Please run the installer command from the Kinome UI." -ForegroundColor Red
    return
}

$ErrorActionPreference = "Stop"

# Configuration
$AppDir = "$env:APPDATA\Kinome"
$HandlerDir = "$AppDir\handler"
$ConfigFile = Join-Path $HandlerDir "handler.conf"
$HandlerBinary = Join-Path $HandlerDir "kinome-handler-win.exe"
$LogFile = Join-Path $HandlerDir "handler.log"

# Create directories
Write-Host "Creating Kinome handler directory..." -ForegroundColor Cyan
if (!(Test-Path $HandlerDir)) {
    New-Item -ItemType Directory -Path $HandlerDir -Force | Out-Null
}

# Download handler binary
Write-Host "Downloading handler binary..." -ForegroundColor Cyan

if (-not $BaseUrl) {
    Write-Host "ERROR: Unable to determine server URL. Please copy the installer command from the Kinome UI." -ForegroundColor Red
    return
}

$BinaryUrl = "$BaseUrl/bin/kinome-handler-win.exe"

try {
    # Disable progress bar to speed up download significantly
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $HandlerBinary
} catch {
    Write-Host "ERROR: Failed to download handler binary from $BinaryUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return
}

# Update or create config (simple text file, one secret per line)
Write-Host "Configuring secret..." -ForegroundColor Cyan
if (Test-Path $ConfigFile) {
    $secrets = Get-Content $ConfigFile
    if ($secrets -notcontains $Secret) {
        Add-Content -Path $ConfigFile -Value $Secret -Encoding UTF8
        Write-Host "Added new secret to existing configuration." -ForegroundColor Green
    } else {
        Write-Host "Secret already exists in configuration." -ForegroundColor Yellow
    }
} else {
    Set-Content -Path $ConfigFile -Value $Secret -Encoding UTF8
    Write-Host "Created new configuration." -ForegroundColor Green
}

# Register protocol handler
Write-Host "Registering kinome:// protocol..." -ForegroundColor Cyan
$RegPath = "HKCU:\Software\Classes\kinome"
if (!(Test-Path $RegPath)) {
    New-Item -Path $RegPath -Force | Out-Null
}
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value "URL:Kinome Protocol"
Set-ItemProperty -Path $RegPath -Name "URL Protocol" -Value ""

$CommandPath = "$RegPath\shell\open\command"
if (!(Test-Path $CommandPath)) {
    New-Item -Path "$RegPath\shell" -Force | Out-Null
    New-Item -Path "$RegPath\shell\open" -Force | Out-Null
    New-Item -Path $CommandPath -Force | Out-Null
}

# Point directly to the Go binary
# The Go binary is compiled with -H windowsgui so it starts hidden
Set-ItemProperty -Path $CommandPath -Name "(Default)" -Value """$HandlerBinary"" ""%1"""

Write-Host ""
Write-Host "==================== Installation Complete ====================" -ForegroundColor Green
Write-Host "Handler installed to: $HandlerDir" -ForegroundColor White
Write-Host "Configuration: $ConfigFile" -ForegroundColor White
Write-Host "Protocol kinome:// registered successfully." -ForegroundColor White
Write-Host ""
Write-Host "Next step: Click 'Test Connection' in the Kinome UI to verify." -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Green
