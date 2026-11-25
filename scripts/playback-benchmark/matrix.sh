#!/usr/bin/env bash
# matrix.sh <out.jsonl> <mbit, 0 for unthrottled> <trials>
# Alternates the new build (port 3200) and the old build (port 3201) for each case.
# The item IDs belong to the two benchmark libraries. Replace them after a fresh scan.
HERE=$(cd "$(dirname "$0")" && pwd)
declare -A A=( [direct]=5093a309-5dd3-4e13-9cfd-d8b8ff35a7f8 [mkv]=ca9cb363-8be1-4c04-87d2-aad7d20359a5 [hevc]=e4a398b4-8078-417b-8848-488737d6fd20 )
declare -A Bm=( [direct]=589421bb-5c01-4702-b13a-83bbfb8850e8 [mkv]=739c359e-6d5f-4cc6-9ce9-278d2602b86c [hevc]=c5821a7b-2e62-4aab-9f83-1270b79929c2 )
OUT=$1; MBIT=$2; TRIALS=$3
for trial in $(seq 1 $TRIALS); do
 for c in "direct source" "mkv source" "mkv 720p" "hevc source"; do file=${c% *}; quality=${c#* }; out=$OUT; mbit=$MBIT
  for resume in 0 0.5; do
   for build in new old; do
    if [ $build = new ]; then origin=http://localhost:3200; id=${A[$file]}; else origin=http://localhost:3201; id=${Bm[$file]}; fi
    r=$(ORIGIN=$origin timeout 150 bun $HERE/perf.ts $id $quality $resume $mbit 2>/dev/null | tail -1)
    echo "{\"build\":\"$build\",\"file\":\"$file\",\"quality\":\"$quality\",\"resume\":$resume,\"r\":${r:-null}}" >> $out
   done
  done
 done
done
