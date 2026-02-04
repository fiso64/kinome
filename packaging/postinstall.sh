#!/bin/sh
# Create user and group if they don't exist
if ! getent group media-browser >/dev/null; then
    groupadd -r media-browser
fi

if ! getent passwd media-browser >/dev/null; then
    useradd -r -g media-browser -d /var/lib/media-browser -s /sbin/nologin -c "Media Browser User" media-browser
fi

# Ensure data directory exists and has permissions
mkdir -p /var/lib/media-browser
chown -R media-browser:media-browser /var/lib/media-browser