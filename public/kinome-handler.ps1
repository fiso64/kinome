# kinome-handler.ps1 - Local Protocol Handler for kinome://
# Handles two command types:
# 1. kinome://run?secret=XXX&command=BASE64_ENCODED_COMMAND
# 2. kinome://test?secret=XXX&url=BASE64_ENCODED_URL

param(
    [Parameter(Mandatory=$true)]
    [string]$Uri
)

$ErrorActionPreference = "Stop"

# Configuration
$HandlerDir = "$env:APPDATA\Kinome\handler"
$ConfigFile = Join-Path $HandlerDir "handler-config.json"
$LogFile = Join-Path $HandlerDir "handler.log"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
    $logEntry = "[$timestamp] $Message"
    Add-Content -Path $LogFile -Value $logEntry -Encoding UTF8
}

function Mask-Token {
    param([string]$Url)
    return $Url -replace '(token=)([^&]{3})[^&]*([^&]{3})', '$1$2***$3'
}

function Test-Secret {
    param(
        [object]$Config,
        [string]$ProvidedSecret
    )
    return $Config.secrets -contains $ProvidedSecret
}

function Invoke-Command {
    param([string]$CommandString)
    
    Write-Log "Executing: $(Mask-Token $CommandString)"
    
    try {
        # Parse command into executable and arguments
        if ($CommandString -match '^"([^"]+)"(.*)$') {
            $exe = $matches[1]
            $args = $matches[2].Trim()
        } elseif ($CommandString -match '^([^\s]+)(.*)$') {
            $exe = $matches[1]
            $args = $matches[2].Trim()
        } else {
            throw "Invalid command format"
        }
        
        # Start process detached
        Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden
        Write-Log "Command spawned successfully"
    } catch {
        Write-Log "ERROR: Command execution failed: $($_.Exception.Message)"
    }
}

function Invoke-HandshakeTest {
    param([string]$Url)
    
    Write-Log "Pinging handshake URL: $Url"
    
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 5 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Log "Handshake successful"
        } else {
            Write-Log "ERROR: Handshake failed: HTTP $($response.StatusCode)"
        }
    } catch {
        Write-Log "ERROR: Handshake failed: $($_.Exception.Message)"
    }
}

# Main execution
try {
    Write-Log "Handler invoked with URL: $Uri"
    
    # Parse kinome:// URL
    if (-not $Uri.StartsWith('kinome://')) {
        Write-Log "ERROR: Invalid protocol (expected kinome://)"
        exit 1
    }
    
    # Remove protocol and parse
    $uriWithoutProtocol = $Uri -replace '^kinome://', ''
    # Handle optional leading slash
    $uriWithoutProtocol = $uriWithoutProtocol -replace '^/+', ''
    
    # Parse action and query string
    if ($uriWithoutProtocol -match '^([^?]+)\??(.*)$') {
        $action = $matches[1] -replace '/$', ''  # Remove trailing slash
        $queryString = $matches[2]
    } else {
        Write-Log "ERROR: Failed to parse URL"
        exit 1
    }
    
    # Parse query parameters
    $params = @{}
    if ($queryString) {
        foreach ($pair in $queryString.Split('&')) {
            if ($pair -match '^([^=]+)=(.*)$') {
                $key = $matches[1]
                $value = $matches[2]
                # URL decode: replace + with space, then decode %XX sequences
                $value = $value -replace '\+', ' '
                $value = [System.Text.RegularExpressions.Regex]::Replace($value, '%([0-9A-Fa-f]{2})', { param($m) [char][Convert]::ToByte($m.Groups[1].Value, 16) })
                $params[$key] = $value
            }
        }
    }
    
    $secret = $params['secret']
    
    # Load and validate config
    if (-not (Test-Path $ConfigFile)) {
        Write-Log "ERROR: Config file not found"
        exit 1
    }
    
    $config = Get-Content $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    
    if (-not (Test-Secret -Config $config -ProvidedSecret $secret)) {
        Write-Log "ERROR: Secret validation failed"
        exit 1
    }
    
    Write-Log "Secret validated"
    
    # Handle action
    if ($action -eq 'run') {
        $encodedCommand = $params['command']
        if (-not $encodedCommand) {
            Write-Log "ERROR: Missing command parameter"
            exit 1
        }
        
        $commandString = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedCommand))
        Invoke-Command -CommandString $commandString
        
    } elseif ($action -eq 'test') {
        $encodedUrl = $params['url']
        if (-not $encodedUrl) {
            Write-Log "ERROR: Missing url parameter"
            exit 1
        }
        
        $handshakeUrl = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedUrl))
        Invoke-HandshakeTest -Url $handshakeUrl
        
    } else {
        Write-Log "ERROR: Unknown action: $action"
        exit 1
    }
    
    exit 0
    
} catch {
    Write-Log "FATAL: $($_.Exception.Message)"
    exit 1
}
