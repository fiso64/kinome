# Kinome Handler Installer for Windows
# Usage: irm http://your-server/install-kinome-handler.ps1?secret=YOUR_SECRET | iex

# Secret is embedded by the server when the script is downloaded

if (-not $Secret) {
    Write-Host "ERROR: No secret provided. Please run the installer command from the Kinome UI." -ForegroundColor Red
    return
}

$ErrorActionPreference = "Stop"

# Configuration
$AppDir = "$env:APPDATA\Kinome"
$HandlerDir = "$AppDir\handler"
$ConfigFile = Join-Path $HandlerDir "handler-config.json"
$HandlerScript = Join-Path $HandlerDir "kinome-handler.ps1"
$LogFile = Join-Path $HandlerDir "handler.log"

# Create directories
Write-Host "Creating Kinome handler directory..." -ForegroundColor Cyan
if (!(Test-Path $HandlerDir)) {
    New-Item -ItemType Directory -Path $HandlerDir -Force | Out-Null
}

# Download handler script
Write-Host "Downloading handler script..." -ForegroundColor Cyan

if (-not $BaseUrl) {
    Write-Host "ERROR: Unable to determine server URL. Please copy the installer command from the Kinome UI." -ForegroundColor Red
    return
}

$HandlerUrl = "$BaseUrl/kinome-handler.ps1"

try {
    Invoke-WebRequest -Uri $HandlerUrl -OutFile $HandlerScript
} catch {
    Write-Host "ERROR: Failed to download handler script from $HandlerUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    return
}

# Update or create config
Write-Host "Configuring secret..." -ForegroundColor Cyan
if (Test-Path $ConfigFile) {
    $config = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.secrets -notcontains $Secret) {
        $config.secrets += $Secret
        # Use UTF8 without BOM to prevent JSON parse errors
        $json = $config | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($ConfigFile, $json, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "Added new secret to existing configuration." -ForegroundColor Green
    } else {
        Write-Host "Secret already exists in configuration." -ForegroundColor Yellow
    }
} else {
    $config = @{
        secrets = @($Secret)
    }
    # Use UTF8 without BOM to prevent JSON parse errors
    $json = $config | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($ConfigFile, $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "Created new configuration." -ForegroundColor Green
}

# Create VBScript launcher (prevents console window from appearing)
Write-Host "Creating launcher..." -ForegroundColor Cyan
$LauncherScript = Join-Path $HandlerDir "launcher.vbs"
$VBScript = @"
Set objShell = CreateObject("WScript.Shell")
Set objArgs = WScript.Arguments
If objArgs.Count > 0 Then
    command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$HandlerScript"" -Uri """ & objArgs(0) & """"
    objShell.Run command, 0, False
End If
"@
Set-Content -Path $LauncherScript -Value $VBScript -Encoding ASCII

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

# Use VBScript launcher to hide window
Set-ItemProperty -Path $CommandPath -Name "(Default)" -Value """wscript.exe"" ""$LauncherScript"" ""%1"""

Write-Host ""
Write-Host "==================== Installation Complete ====================" -ForegroundColor Green
Write-Host "Handler installed to: $HandlerDir" -ForegroundColor White
Write-Host "Configuration: $ConfigFile" -ForegroundColor White
Write-Host "Protocol kinome:// registered successfully." -ForegroundColor White
Write-Host ""
Write-Host "Next step: Click 'Test Connection' in the Kinome UI to verify." -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Green
