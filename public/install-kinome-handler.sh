#!/bin/bash
# Kinome Handler Installer for Linux/macOS
# Usage: curl -fsSL http://your-server/install-kinome-handler.sh | SECRET=YOUR_SECRET bash

set -e

# Get secret from environment or fail
if [ -z "$SECRET" ]; then
    echo "ERROR: No secret provided. Please run the installer command from the Kinome UI."
    exit 1
fi

if [ -z "$BASE_URL" ]; then
    echo "ERROR: Unable to determine server URL. Please copy the installer command from the Kinome UI."
    exit 1
fi

# Detect OS and Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux)
        OS_TYPE="linux"
        ;;
    Darwin)
        OS_TYPE="darwin"
        ;;
    *)
        echo "ERROR: Unsupported OS: $OS"
        exit 1
        ;;
esac

case "$ARCH" in
    x86_64)
        ARCH_TYPE="amd64"
        ;;
    aarch64|arm64)
        ARCH_TYPE="arm64"
        ;;
    *)
        echo "ERROR: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Construct binary name
BINARY_NAME="kinome-handler-$OS_TYPE-$ARCH_TYPE"

# Configuration
CONFIG_DIR="$HOME/.config/kinome"
HANDLER_DIR="$CONFIG_DIR/handler"
CONFIG_FILE="$HANDLER_DIR/handler.conf"
# We save it as just 'kinome-handler' in the handler dir for simplicity
HANDLER_BINARY="$HANDLER_DIR/kinome-handler"
BIN_DIR="$HOME/.local/bin"
BIN_LINK="$BIN_DIR/kinome-handler"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/kinome-handler.desktop"

# Create directories
echo "Creating Kinome handler directory..."
mkdir -p "$HANDLER_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$DESKTOP_DIR"

# Download handler binary
echo "Downloading handler binary ($BINARY_NAME)..."

DOWNLOAD_URL="$BASE_URL/bin/$BINARY_NAME"

if command -v curl > /dev/null; then
    curl -fsSL "$DOWNLOAD_URL" -o "$HANDLER_BINARY"
elif command -v wget > /dev/null; then
    wget -q "$DOWNLOAD_URL" -O "$HANDLER_BINARY"
else
    echo "ERROR: Neither curl nor wget found. Please install one of them."
    exit 1
fi

chmod +x "$HANDLER_BINARY"

# Update or create config (simple text file, one secret per line)
echo "Configuring secret..."
if [ -f "$CONFIG_FILE" ]; then
    if grep -qF "$SECRET" "$CONFIG_FILE"; then
        echo "Secret already exists in configuration."
    else
        echo "$SECRET" >> "$CONFIG_FILE"
        echo "Added new secret to existing configuration."
    fi
else
    echo "$SECRET" > "$CONFIG_FILE"
    echo "Created new configuration."
fi

# Create symlink in ~/.local/bin
echo "Creating symlink..."
ln -sf "$HANDLER_BINARY" "$BIN_LINK"

# Register protocol handler
if [ "$OS_TYPE" = "linux" ]; then
    echo "Registering kinome:// protocol..."
    cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Type=Application
Name=Kinome Handler
Exec=$HANDLER_BINARY %u
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
fi

if [ "$OS_TYPE" = "darwin" ]; then
    echo "Registering kinome:// protocol (macOS)..."
    APP_BUNDLE="$HOME/Applications/Kinome Handler.app"
    mkdir -p "$APP_BUNDLE/Contents/MacOS"
    
    # 1. Create the Info.plist with URL Scheme registration
    cat > "$APP_BUNDLE/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.fiso.kinome.handler</string>
    <key>CFBundleName</key>
    <string>Kinome Handler</string>
    <key>CFBundleExecutable</key>
    <string>kinome-handler</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Kinome Protocol</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>kinome</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
EOF

    # 2. Symlink the downloaded binary into the bundle
    ln -sf "$HANDLER_BINARY" "$APP_BUNDLE/Contents/MacOS/kinome-handler"
    
    # 3. Force registration with Launch Services
    # We use the absolute path to lsregister which is standard on macOS
    LSR="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
    if [ -f "$LSR" ]; then
        "$LSR" -f "$APP_BUNDLE"
    fi
    
    # 4. Remove quarantine attribute
    xattr -d com.apple.quarantine "$HANDLER_BINARY" 2>/dev/null || true
fi

echo ""
echo "==================== Installation Complete ===================="
echo "Handler installed to: $HANDLER_DIR"
echo "Configuration: $CONFIG_FILE"
if [ "$OS_TYPE" = "linux" ] || [ "$OS_TYPE" = "darwin" ]; then
    echo "Protocol kinome:// registered successfully."
fi
echo ""
echo "Next step: Click 'Test Connection' in the Kinome UI to verify."
echo "==============================================================="
