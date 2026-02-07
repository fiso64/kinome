#!/bin/bash
# kinome-handler.sh - Local Protocol Handler for kinome://
# Handles two command types:
# 1. kinome://run?secret=XXX&command=BASE64_ENCODED_COMMAND
# 2. kinome://test?secret=XXX&url=BASE64_ENCODED_URL

set -e

# Configuration
CONFIG_DIR="$HOME/.config/kinome/handler"
CONFIG_FILE="$CONFIG_DIR/handler-config.json"
LOG_FILE="$CONFIG_DIR/handler.log"

# Logging function
log() {
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
    echo "[$timestamp] $1" >> "$LOG_FILE"
}

# Mask tokens in URLs
mask_token() {
    echo "$1" | sed -E 's/(token=)([^&]{3})[^&]*([^&]{3})/\1\2***\3/g'
}

# Validate secret
validate_secret() {
    local provided_secret="$1"
    local config_secrets=$(jq -r '.secrets[]' "$CONFIG_FILE" 2>/dev/null)
    
    for secret in $config_secrets; do
        if [ "$secret" = "$provided_secret" ]; then
            return 0
        fi
    done
    return 1
}

# Execute command
execute_command() {
    local command_string="$1"
    log "Executing: $(mask_token "$command_string")"
    
    # Execute command in background, detached
    nohup bash -c "$command_string" > /dev/null 2>&1 &
    
    log "Command spawned successfully"
}

# Ping handshake URL
ping_handshake() {
    local url="$1"
    log "Pinging handshake URL: $url"
    
    if curl -s -o /dev/null -w "%{http_code}" "$url" | grep -q "200"; then
        log "Handshake successful"
    else
        log "ERROR: Handshake failed"
    fi
}

# Main execution
URL="$1"

log "Handler invoked with URL: $URL"

# Validate protocol
if [[ ! "$URL" =~ ^kinome:// ]]; then
    log "ERROR: Invalid protocol (expected kinome://)"
    exit 1
fi

# Parse URL - remove protocol and optional leading slashes
URL_WITHOUT_PROTOCOL="${URL#kinome://}"
URL_WITHOUT_PROTOCOL="${URL_WITHOUT_PROTOCOL#/}"

# Extract action and query string
if [[ "$URL_WITHOUT_PROTOCOL" =~ ^([^?]+)\??(.*)$ ]]; then
    ACTION="${BASH_REMATCH[1]}"
    QUERY_STRING="${BASH_REMATCH[2]}"
else
    log "ERROR: Failed to parse URL"
    exit 1
fi

# Parse query parameters
declare -A PARAMS
if [ -n "$QUERY_STRING" ]; then
    IFS='&' read -ra PAIRS <<< "$QUERY_STRING"
    for pair in "${PAIRS[@]}"; do
        if [[ "$pair" =~ ^([^=]+)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            # URL decode
            value=$(printf '%b' "${value//%/\\x}")
            PARAMS[$key]="$value"
        fi
    done
fi

SECRET="${PARAMS[secret]}"

# Load and validate config
if [ ! -f "$CONFIG_FILE" ]; then
    log "ERROR: Config file not found"
    exit 1
fi

if ! validate_secret "$SECRET"; then
    log "ERROR: Secret validation failed"
    exit 1
fi

log "Secret validated"

# Handle action
case "$ACTION" in
    run)
        ENCODED_COMMAND="${PARAMS[command]}"
        if [ -z "$ENCODED_COMMAND" ]; then
            log "ERROR: Missing command parameter"
            exit 1
        fi
        
        COMMAND_STRING=$(echo "$ENCODED_COMMAND" | base64 -d)
        execute_command "$COMMAND_STRING"
        ;;
        
    test)
        ENCODED_URL="${PARAMS[url]}"
        if [ -z "$ENCODED_URL" ]; then
            log "ERROR: Missing url parameter"
            exit 1
        fi
        
        HANDSHAKE_URL=$(echo "$ENCODED_URL" | base64 -d)
        ping_handshake "$HANDSHAKE_URL"
        ;;
        
    *)
        log "ERROR: Unknown action: $ACTION"
        exit 1
        ;;
esac

exit 0
