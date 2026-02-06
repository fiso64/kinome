#!/bin/sh
# Create user and group if they don't exist
if ! getent group kinome >/dev/null; then
    groupadd -r kinome
fi

if ! getent passwd kinome >/dev/null; then
    useradd -r -g kinome -d /var/lib/kinome -s /sbin/nologin -c "Kinome User" kinome
fi

# Ensure data directory exists and has permissions
mkdir -p /var/lib/kinome
chown -R kinome:kinome /var/lib/kinome