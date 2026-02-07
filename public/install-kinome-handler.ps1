# Kinome Handler Installer for Windows
# Usage: irm http://your-server/install-kinome-handler.ps1?secret=YOUR_SECRET | iex

# Secret is embedded by the server when the script is downloaded

if (-not $Secret) {
    Write-Host "ERROR: No secret provided. Please run the installer command from the Kinome UI." -ForegroundColor Red
    exit 1
}

$ErrorActionPreference = "Stop"

# Configuration
$AppDir = "$env:APPDATA\Kinome"
$ConfigFile = Join-Path $AppDir "handler-config.json"
$HandlerScript = Join-Path $AppDir "kinome-handler.js"
$LauncherScript = Join-Path $AppDir "launcher.vbs"

# Create directory
Write-Host "Creating Kinome application directory..." -ForegroundColor Cyan
if (!(Test-Path $AppDir)) {
    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
}

# Download handler script
Write-Host "Downloading handler script..." -ForegroundColor Cyan
$HandlerUrl = "$($env:HTTP_REFERER -replace '/install-kinome-handler\.ps1.*', '')/kinome-handler.js"
if (-not $HandlerUrl.StartsWith('http')) {
    $HandlerUrl = "http://localhost:3000/kinome-handler.js"
}

try {
    Invoke-WebRequest -Uri $HandlerUrl -OutFile $HandlerScript
} catch {
    Write-Host "ERROR: Failed to download handler script from $HandlerUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# Update or create config
Write-Host "Configuring secret..." -ForegroundColor Cyan
if (Test-Path $ConfigFile) {
    $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    if ($config.secrets -notcontains $Secret) {
        $config.secrets += $Secret
        $config | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
        Write-Host "Added new secret to existing configuration." -ForegroundColor Green
    } else {
        Write-Host "Secret already exists in configuration." -ForegroundColor Yellow
    }
} else {
    $config = @{
        secrets = @($Secret)
    }
    $config | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
    Write-Host "Created new configuration." -ForegroundColor Green
}

# Create VBScript launcher (hides console window)
Write-Host "Creating launcher..." -ForegroundColor Cyan
$VBScript = @"
Set objShell = CreateObject("WScript.Shell")
Set objArgs = WScript.Arguments
If objArgs.Count > 0 Then
    command = """node"" ""$HandlerScript"" """ & objArgs(0) & """"
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
Set-ItemProperty -Path $CommandPath -Name "(Default)" -Value """wscript.exe"" ""$LauncherScript"" ""%1"""

Write-Host ""
Write-Host "==================== Installation Complete ====================" -ForegroundColor Green
Write-Host "Handler installed to: $AppDir" -ForegroundColor White
Write-Host "Configuration: $ConfigFile" -ForegroundColor White
Write-Host "Protocol kinome:// registered successfully." -ForegroundColor White
Write-Host ""
Write-Host "Next step: Click 'Test Connection' in the Kinome UI to verify." -ForegroundColor Cyan
Write-Host "===============================================================" -ForegroundColor Green
