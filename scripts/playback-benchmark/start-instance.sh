#!/usr/bin/env bash
# start-instance.sh <a|b> <kinome checkout> <port>
# Runs one isolated instance with its own data and library under $BENCH/<a|b>. Needs ffmpeg on PATH.
set -e
D=${BENCH:?set BENCH to the benchmark work directory}/$1
echo '{"server":{"libraryLocation":"'$D'/media/.library"},"libraryDefaults":{}}' > $D/data/settings.json
[ -f $D/media/.library/library-settings.json ] || echo '{"mediaSources":[{"id":"bench-source","path":".","isRelative":true}]}' > $D/media/.library/library-settings.json
cd $2
exec env NODE_ENV=production KINOME_DATA=$D/data KINOME_HOST=127.0.0.1 KINOME_PORT=$3 bun src/main/server.ts > $D/server.log 2>&1
