# Web player playback benchmark

Compares two Kinome builds on start time, resumed start, random seeks and steady playback, for direct play, remux and transcode. It drives the real player in headless Chromium and can throttle the connection. Written for the audit on 2026-11-25. Kept as reference, not as a maintained tool.

## What is here

| File | Purpose |
| --- | --- |
| `start-instance.sh` | Runs one isolated Kinome instance with its own data folder and library. |
| `matrix.sh` | Runs every case against both builds, alternating, and appends one JSON line per trial. |
| `perf.ts` | One trial through the real player UI: opens a title, clicks Play, times the first frame, five seeks and five seconds of playback. `TRACE=1` prints request timings instead. |
| `stream.ts` | One trial at the stream level with a bare `<video>` and hls.js, using the old or new hls.js configuration. `MARKS=1` prints the start timeline. Also reports per-seek phases. |
| `stress.ts` | Seeks repeatedly on a throttled link, interrupting half of them, and reports hls.js errors. `GUARD=1` adds the abandoned-segment guard. |
| `resumed-start.ts` | Times a resumed start at the HTTP level and checks that the initialization is identical from any job. |
| `summary.ts` | Prints medians per case and build from a results file. |
| `cdp.ts` | Minimal Chrome DevTools driver shared by the scripts. |
| `results/2026-11-25/` | Raw results from the audit. |

## Setup used for the audit

1. Work directory with two libraries holding the same three files, `a` for the new build and `b` for the old one. Hard links keep it to one copy.
   - `Transmux/transmux.mkv`: H.264 with AAC in Matroska, keyframes about 10 s apart, 5.5 Mbit/s, 464 s.
   - `Direct/direct.mp4`: the same streams in MP4 with the index at the front.
   - `Hevc/hevc.mkv`: HEVC, which headless Chromium cannot decode, so it is transcoded.
2. Old build in a git worktree at the baseline commit with `node_modules` linked and `bun run build` run there. New build is the working tree.
3. `BENCH=<work dir> ./start-instance.sh a <working tree> 3200` and `... b <worktree> 3201`.
4. On each instance: create `admin` / `q` with the setup token in its data folder, then `POST /api/perform-scan`.
5. Put the scanned item IDs into `matrix.sh`.
6. `CHROMIUM=<path> ./matrix.sh out.jsonl 0 3`, then `bun summary.ts out.jsonl`. Use `8` instead of `0` for an 8 Mbit/s link.

A full unthrottled run of three trials takes about 15 minutes. Run single cases with `perf.ts` when only one path changed.

## Results on 2026-11-25

Six-core i5-8500, loopback, FFmpeg 9.0.1, Chromium 158. Median milliseconds, old build to new build. Two or three trials per cell, so differences under about 40 ms are noise.

Fast link, final build (`fast-final.jsonl`):

| Case | Start | Resumed start | Seek |
| --- | --- | --- | --- |
| MP4, direct play | 160 → 117 | 199 → 246 | 100 → 117 |
| MKV, old direct play, new remux | 111–154 → 221–245 | 201–264 → 363–376 | about 130 → 170 |
| 720p transcode | 294–330 → 280 | 345–369 → 343–347 | about 240 → 240 |
| HEVC source, transcoded | 393 → 374 | 696 → 471 | 479 → 471 |

8 Mbit/s link, remux of the long-keyframe file:

| Measurement | Old | New before fix | New after fix |
| --- | --- | --- | --- |
| Start, stream level (TS progressive before, MP4 after) | 419 | 3,499 | 280 |
| Resumed start at 50%, player (old is direct play) | 2,432 | 7,396 | about 3,000 |
| Interrupted-seek stress, buffer append errors | 0 | 4 without the guard | 0 |

## What the audit changed

- A resumed start no longer runs a conversion job at the start of the file for the initialization. The player sends its start position and the server uses that segment's job.
- hls.js requests the first segment as soon as the playlist arrives (`startFragPrefetch`) and no longer waits for a 100 ms timer.
- MP4 segments are written in one-second fragments and hls.js runs in progressive mode, so a long segment is presented while it downloads.
- A seek that leaves a partly delivered segment discards its unparsed remainder.
- The player moves to the resume position as soon as that position is buffered.

## Limits

- Chromium only. Firefox and Safari were not measured.
- One machine, loopback. Throttling is Chromium's network emulation.
- Old-build MKV runs log a fallback warning and one seek per run timed out in the harness, most likely caught during a source switch.
