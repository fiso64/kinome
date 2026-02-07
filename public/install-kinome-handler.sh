#!/bin/bash
# Kinome Handler Installer for Linux/macOS
# Usage: curl -fsSL http://your-server/install-kinome-handler.sh | SECRET=YOUR_SECRET bash

set -e

# Get secret from environment or fail
if [ -z "$SECRET" ]; then
    echo "ERROR: No secret provided. Please run the installer command from the Kinome UI."
    exit 1
fi

# Configuration
CONFIG_DIR="$HOME/.config/kinome"
CONFIG_FILE="$CONFIG_DIR/handler-config.json"
HANDLER_SCRIPT="$CONFIG_DIR/kinome-handler.js"
BIN_DIR="$HOME/.local/bin"
BIN_SCRIPT="$BIN_DIR/kinome-handler"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/kinome-handler.desktop"

# Create directories
echo "Creating Kinome application directory..."
mkdir -p "$CONFIG_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$DESKTOP_DIR"

# Download handler script
echo "Downloading handler script..."
if command -v curl > /dev/null; then
    # Try to get base URL from HTTP_REFERER or use localhost
    BASE_URL="${HTTP_REFERER%/install-kinome-handler.sh*}"
    if [ -z "$BASE_URL" ]; then
        BASE_URL="http://localhost:3000"
    fi
    curl -fsSL "$BASE_URL/kinome-handler.js" -o "$HANDLER_SCRIPT"
elif command -v wget > /dev/null; then
    BASE_URL="${HTTP_REFERER%/install-kinome-handler.sh*}"
    if [ -z "$BASE_URL" ]; then
        BASE_URL="http://localhost:3000"
    fi
    wget -q "$BASE_URL/kinome-handler.js" -O "$HANDLER_SCRIPT"
else
    echo "ERROR: Neither curl nor wget found. Please install one of them."
    exit 1
fi

chmod +x "$HANDLER_SCRIPT"

# Update or create config
echo "Configuring secret..."
if [ -f "$CONFIG_FILE" ]; then
    # Check if secret already exists
    if grep -q "\"$SECRET\"" "$CONFIG_FILE" 2>/dev/null; then
        echo "Secret already exists in configuration."
    else
        # Add secret to existing array using jq if available, otherwise manual
        if command -v jq > /dev/null; then
            jq ".secrets += [\"$SECRET\"]" "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
            mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
        else
            # Manual JSON manipulation (simple append)
            sed -i.bak 's/\(\"secrets\": \[\)/\1\"'"$SECRET"'\", /' "$CONFIG_FILE"
        fi
        echo "Added new secret to existing configuration."
    fi
else
    cat > "$CONFIG_FILE" << EOF
{
  "secrets": ["$SECRET"]
}
EOF
    echo "Created new configuration."
fi

# Create wrapper script
echo "Creating handler wrapper..."
cat > "$BIN_SCRIPT" << 'EOF'
#!/bin/bash
exec node "$HOME/.config/kinome/kinome-handler.js" "$@"
EOF
chmod +x "$BIN_SCRIPT"

# Create .desktop file
echo "Registering kinome:// protocol..."
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Type=Application
Name=Kinome Handler
Exec=$BIN_SCRIPT %u
StartupNotify=false
MimeType=x-scheme-handler/kinome;
NoDisplay=true
EOF

# Update MIME database
if command -v update-desktop-database > /dev/null; then
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

# Set as default handler for kinome:// protocol
if command -v xdg-mime > /dev/null; then
    xdg-mime default kinome-handler.desktop x-scheme-handler/kinome 2>/dev/null || true
fi

echo ""
echo "==================== Installation Complete ===================="
echo "Handler installed to: $CONFIG_DIR"
echo "Configuration: $CONFIG_FILE"
echo "Protocol kinome:// registered successfully."
echo ""
echo "Next step: Click 'Test Connection' in the Kinome UI to verify."
echo "==============================================================="
