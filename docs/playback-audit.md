# Playback audit

2026-11-21. An isolated Kinome server read real files from the SSD and HDD. Generated media, conversion output and the test database lived on the SSD. The original media files were opened read-only.

## Clicks and seeks

Each cell shows the median baseline → patched time in milliseconds. Five interleaved fresh Chromium profiles per build and case clicked a library tile, then sought to 72%, 16% and 89% through the player control. The clock stopped on a presented frame. The OS file cache could be warm. Both production builds used FFmpeg 9.0.1 on the same six-core i5-8500. Other local playback checks ran concurrently during some trials. Small LAN timing differences are sensitive to scheduling. Seek medians pool all 15 seeks per cell.

| Source and playback path | Client and network | Click to first frame | Seek to frame |
| --- | --- | ---: | ---: |
| 96 s H.264/AAC MP4, original | LAN | 173 → 141 | 44 → 42 |
| Same streams in MKV, remux | LAN | 371 → 258 | 77 → 87 |
| Same MKV, 480p transcode | LAN | 422 → 357 | 170 → 208 |
| MP4, original | 4× CPU slowdown, 8 Mbps, 85 ms | 887 → 726 | 760 → 773 |
| MKV, remux | Same | 2,760 → 1,425 | 1,255 → 1,102 |
| MKV, 480p transcode | Same | 1,994 → 1,229 | 900 → 694 |
| 106 GB HDD HDR10 HEVC movie, 720p transcode | 8 Mbps, 85 ms | 3,025 → 1,341 | 1,011 → 945 |

For the movie, a 1,167,641-byte playlist took 26,071 bytes on the wire including browser-reported response overhead. The HLS library went from 599,345 to 189,027 transferred bytes. The first media segment stayed the same size. Separate packet-level shaping at 12 Mbps, 40 ms ±12 ms delay and 0.35% loss exercised retransmission. All nine seeks completed across the three short-file paths. On the lossy link, letting HLS.js parse MPEG-TS as bytes arrived reduced median first-frame time for the 1080p remux from 4.36 s to 1.36 s and median seek time from 7.25 s to 3.20 s in two runs per setting. A separate three-run switch test found little change in audio-reload time. Fragmented MP4 keeps whole-fragment loading because its decoder needs complete fragments.

For a drive comparison, the same 50 MiB H.264/AAC MP4 was copied to each mount. Before each of 18 LAN runs, Linux reported zero resident source pages. Across three trials per mode, SSD/HDD median startup was 229/152 ms for original, 250/305 ms for remux and 339/369 ms for 480p. Corresponding seeks were 57/46, 80/119 and 269/292 ms. Drive firmware caches and other host activity could still affect these measurements.

Constraining Chromium and its decoder processes to one logical CPU in addition to main-thread and network throttling made a high-bitrate 1080p remux expensive. Startup took 6.23 s and seeks took 5.86–14.03 s. The 720p conversion of the UHD movie started in 2.00 s and sought in 1.03–1.80 s. These are individual runs with different sources. Physical mobile decoders, battery draw, speakers, Safari and iOS remain unmeasured.

## Continuity and switching

- A continuously generated tone went silent for 272–288 ms at FFmpeg window boundaries with 11.95 s buffered and no browser waiting event. Some full conversions overlapped AAC packets. An open-GOP source with a nonzero container start repeated about 0.8 s of video. After aligning stream timestamps, keyframes and AAC sample boundaries, 30 consecutive segments in each of four sources and two conversion modes had no audio or video boundary gap or overlap over 1 ms. Browser WebAudio also found no repeated silence across the same restarts. Median normalized waveform correlation against source audio was 0.996–0.997 in 346 sampled intervals across two real soundtracks and both conversion modes. Relative lag varied by at most 1.63 ms within a run. The controlled 480p SSIM against the source was 0.970916 before and after.
- The 21 min 23 s original played to completion with 30,745 video frames, zero dropped frames, and zero waiting events in the overnight run. The longest gap between presentation callbacks was 133 ms, within a quarter-second of the end. Browser buffering alone cannot guarantee smooth playback.
- SRT and VTT sidecars loaded cues in 16–48 ms. Embedded SubRip took 60 ms. Two ASS switches with embedded fonts took 627–649 ms to mount. Pixel comparison against the same paused frame confirmed rendered ASS and PGS after forward and backward seeks. On a real HDD PGS track the previous extraction took 21.4 s before its first byte. Across 61 indexed windows on three tracks the returned packets matched independent FFmpeg extraction. Window reads took 5–182 ms. For an unindexed MKV, the first full-track extraction took 3.88 s on the HDD. The server now indexes that temporary SUP once and serves the window around the playhead. All 57 requests, including reverse seeks and empty windows, matched the full 27.5 MB reference. Responses were 25–959 kB and took 2–23 ms after extraction. Screenshots showed the same subtitle pixels at 3.6 s and 85.9 s as in the indexed source. Embedded VobSub, sidecar IDX/SUB and sidecar SUP were also checked visually.
- Switching audio took 257–275 ms in the controlled files and 533 ms on a 1080p real file. The controlled switch preserved position within 0.13 s and changed the measured tone to the second track's frequency.
- A variable-frame-rate file with 2.52 s of audio after the final picture originally advertised segments FFmpeg could never produce. The final video segment now carries the remaining audio. Chromium played through to the expected 122.64 s end in remux, audio-only conversion and full conversion.
- Chromium could fail to decode open-GOP video after a seek even with the original file. Automatic mode recovered through video conversion and retained play intent. Forced original playback still depends on the browser decoder. Firefox also played and sought in original H.264 and VP9, H.264 remux, 480p conversion and automatic HEVC playback.
- In 40-second native mpv runs, original, remux and transcode crossed worker boundaries and completed forward and backward seeks with zero dropped frames or cache pauses. Maximum sampled absolute A/V difference was under 9 ms. VLC displayed frames throughout the same three paths. Its MPEG-TS demuxer logged continuity-counter resets at segment boundaries.

## Sustained playback

Each row reached the browser’s ended event. Waiting events were counted after playback started. A callback gap is an interval over 120 ms between video frame callbacks. It can include main-thread scheduling delays. Headless playback measures decoded audio and browser presentation, without a physical screen or speaker.

| Playback path | Duration | Reported video frames | Dropped | Waits | Callback gaps |
| --- | ---: | ---: | ---: | ---: | --- |
| Original H.264/AAC Matroska with an MP4 suffix | 21m 23s | 30,745 | 0 | 0 | 1 near the end |
| H.264 remux with ASS | 25m 02s | 36,008 | 0 | 0 | 5 with over 2 s buffered, longest 133 ms |
| 106 GB HEVC HDR10 to 720p using VAAPI, HDD | 2h 22m 09s | 204,478 | 0 | 0 | 0 |
| HEVC to 480p with bitmap subtitles | 24m 42s | 35,533 | 0 | 0 | 0 |
| Copied video with AAC conversion | 1m 36s | 2,305 | 0 | 0 | 0 |

The overnight measurements above preceded the final HLS loader change. With the final build, a full normal-speed 96 s conversion reported 2,304 frames with zero drops or waits. A three-minute normal-speed remux with ASS during concurrent browser and 4× playback tests dropped 7 of 4,328 frames, with two buffered callback gaps and no waits. At 4× speed the full 25-minute remux reached the end, dropping 14,249 of 36,008 frames. Its waiting events occurred with media buffered. Accelerated playback required roughly 96 source frames per second on this host.

Follow-up replays targeted the three recorded 1× remux callback-gap timestamps at 66.923, 721.181 and 1444.228 seconds. Three fresh Chromium sessions each played through all three points with the same ASS track and no competing audit playback. Across the nine five-second measurement windows, Chromium reported 0 dropped frames and 0 waits. The longest callback interval was 67 ms. The source video timestamps were at most 42 ms apart. Raw results are in `replay-hitches.jsonl`.

An earlier remux observation stopped before the end. The complete repeat above used a separately supervised player and server. Separate forced-software tests confirmed the worker's last used backend and inspected 30 segments of HDR10 conversion. The output was 1280×720 H.264 with limited-range BT.709 primaries, transfer and matrix. There were no packet boundary gaps or overlaps exceeding 1 ms. The 720p software run started in 1.77 s on LAN and took 2.93–4.28 s for movie seeks.

## Other fixes and limits

- Older 10-bit H.264 4:4:4 encoded with x264 build 142 decoded green or corrupt after worker restarts. FFmpeg needs the source encoder version to interpret these pictures. Kinome preserves it for conversion and places it before the first copied picture in independently opened fragments. Source-relative 30 s SSIM rose from 0.582321 to 0.984351. In remux and audio-conversion modes, all 336 decoded frames sampled at seven positions per mode matched source hashes. Encoder presets, bitrate and quality targets were preserved. [FFmpeg CABAC decoder](https://ffmpeg.org/doxygen/trunk/h264__cabac_8c_source.html)
- MPEG-TS and MPEG-PS recordings now seek from a decodable picture, including a transport stream starting between keyframes and a 20 s GOP. Two VFR Matroska remuxes with a 10 s start offset exposed different duration conventions in FFmpeg and mkvmerge. Both now play through their delayed audio to the real 122.64 s end in remux, audio conversion and 480p. The FFmpeg fixture previously stalled at 128.64 s after a seek into the advertised tail.
- MP4 index reads skip unrelated sample tables. On a 38.8 GB source the warm index read went from 21 to 10 ms with the same 3,996 keyframes. A playable file with a 36 MiB movie header now remuxes. Direct byte ranges crossing 4 GiB and at EOF matched disk on 38.8 GB and 106 GB sources. HEAD, suffix and out-of-file responses also passed.
- Aborted and simultaneous seeks now share or release pending work without cancelling another live response. Reverse-adjacent, duplicate and independent-viewer segment requests all completed. Session files disappeared after idle expiry. A five-second link outage left buffered media playing. All three paths resumed at the requested unbuffered position when the link returned, and recovered from repeated connection resets in separate trials.
- Opening a 6,000-file playback queue rendered 200 entries in 36 ms, down from over 500 ms to render all rows. Selecting a later page and reopening on the current item both worked. The player starts media discovery at the click and defers the queue request until the first data or a terminal error.
- Native direct audio switching was checked using Chromium’s opt-in AudioVideoTracks support. The measured tone changed on all three switches with the same video source, in 50 ms, 2.10 s and 99 ms. On the shaped link, a 1080p remux audio switch took 11.3 s while reloading multiplexed media. ASS took 9.73 s to mount cold and 1.57 s on the next switch on that link. Chromium’s network log showed 16 font requests on the wire for 48 font loads across three selections. Actual glyph display depends on the cue timestamp.
- Fixtures covered H.264 including open GOP and 4:4:4, HEVC HDR10, MPEG-2, MPEG-4 Part 2, VP9 and AV1, plus AAC, AC-3, E-AC-3, DTS, FLAC, MP3 and Opus. Coverage varied by fixture. Trials used Matroska, MP4, WebM, AVI, program and transport streams, delayed audio or video, silent video, and variable frame rate.

## Verification and evidence

The full Bun suite with FFmpeg on PATH passed 627 tests in 8.51 s. Type checking and Svelte diagnostics passed. The production build completed and all 21 compressed assets expanded byte-for-byte to their originals. HTTP GET and HEAD selected the expected encoding for HLS JavaScript and subtitle WASM. The redeployed test instance served localhost port 3000 inside the audit network namespace. Original, remux and 720p movie playback each completed three UI seeks there. Host port 3000 already serves another application.

The scratch directory on the SSD is `/mnt/storage/kinome-playback-audit`. The paired trial records are `prod-trial-3004.jsonl` and `prod-trial-3020.jsonl`. The long-run frame records are in `soak.jsonl` and `overnight.jsonl`. The source comparisons are in `hash444.log` and `build-R51-ssim.log`. At closeout, fixtures and measurements occupied 3.0 GiB on the SSD and 566 MiB on the HDD. Only the redeployed development test service was left running.

## Playback fidelity follow-up

- Auto tries a playable original or lossless remux before encoding. A two-track Matroska file exposed a silent track substitution in Chromium. When Chromium could not decode the default AC-3 track, it selected the alternate FLAC soundtrack. Auto now preserves the requested track by copying the picture and converting that soundtrack when necessary.
- A full video conversion can copy the selected audio. The endpoint regression test compares the original FLAC packet hashes with the rendition. AAC conversion preserves mono and multichannel layouts up to eight channels by default. Existing explicit stereo, surround and resolution limits are honored.
- New installations allow up to 4K. On a 106 GB source, the HEVC hardware rendition retained 3840×2160, 10-bit 4:2:0, BT.2020/PQ, mastering-display and content-light metadata. The VP9 and software HEVC 720p renditions retained 10-bit BT.2020/PQ. Chromium decoded the negotiated VP9 rendition with an emulated HDR display capability. Physical HDR presentation remains unverified. A separate AVC conversion retained 10-bit 4:4:4 and copied six-channel FLAC. Ordinary SDR AVC quality settings are unchanged.
- A moving 29.97i MPEG-2 fixture converted to 59.94 progressive frames/s with both software and VAAPI. Segment timestamps were continuous at sequential and random-access job boundaries. In the HDR fixture, fetching a randomly accessed segment at 40 s took 1.23 s at 4K on VAAPI and 3.14 s at 720p on software HEVC on this machine. These are server segment timings.
- Failed native MP4 and HLS requests recovered on their original paths. The MP4 outage generated zero HLS requests. Chromium rendered ASS to a 4201×2363 canvas and loaded the requested Liberation Mono font bytes after local-font permission was granted.

Chromium production-build medians in milliseconds follow. Startup runs from item click to the first presented frame. Each start included three UI seeks. WAN used 85 ms latency and 8 Mbit/s downstream. Constrained runs also used 4× CPU throttling.

| Case | Starts per build | Startup before → after | Seek before → after |
| --- | ---: | ---: | ---: |
| Original MP4, LAN | 3 | 139 → 125 | 45 → 47 |
| Remux, constrained | 3 | 1348 → 1298 | 1071 → 1074 |
| 480p conversion, LAN | 8 | 277 → 267 | 160 → 155 |
| 4K movie converted to 720p SDR, WAN | 3 | 1177 → 1130 | 829 → 805 |
| 480p conversion, constrained | 8 | 1102 → 1104 | 678 → 680 |

Smaller MPEG-TS audio packets recovered roughly 120 ms of constrained startup time observed during development when copying a low-bitrate mono track. The first segment remained smaller than the baseline. One trial hit missing player assets while the benchmark build directory was being rebuilt and was rerun. One native reconnect in development restarted from zero during an edit. Three isolated development repeats and one production repeat all resumed at the requested 73 s. Remux and 480p recovered there as well. Chromium also played and sought the eight-channel AAC conversion, which uses fragmented MP4 for channel layouts that ADTS cannot carry.

The final full suite passed 628 tests. Type checking, Svelte diagnostics and the production build passed. Raw trial records, font checks, segment probes and outage traces are under `/mnt/storage/kinome-playback-audit/fidelity`.

## Web player quality modes

Prefer original (default) and Automatic quality share one playback order. Chromium played the A04 AVI through original → remux → video conversion and the selected R51 soundtrack through remux → audio conversion in both modes. Automatic quality alone dropped a 540p original to 480p after two simulated buffering interruptions. With sustained buffered playback, it returned to the original. Fresh preferences and previously saved remux and fixed-resolution preferences opened in Prefer original. A saved Automatic preference remained selected.

## Automatic quality under changing load

Automatic samples contiguous buffered time and total/dropped frame counters once per second. It checks two delivery windows before a bandwidth downgrade. An imminent stall can shorten the decision. Sustained dropped frames with buffered media provide a separate reason to try the next smaller picture. For a severe bandwidth deficit it can skip one estimated oversize rendition. The recovery path includes that intermediate size. HLS.js prepares a target media fragment while the current source plays. A seek or pause cancels preparation. Recovery uses measured HLS segment size, transfer and generation time, playback speed, a stable buffer, sustained throughput headroom and backoff after a premature upgrade. The default allowed list includes the existing 360p and 240p profiles. Saved server limits take precedence.

The SSD scratch directory `/mnt/storage/kinome-playback-audit/abr` contains the rate schedules, browser and pacing harnesses, raw playback events, and frame counters. The HTTP proxy shares a byte budget across concurrent media requests. Startup and seeks were measured separately. The following waiting times sum intervals from a browser waiting event to the next playing event after startup, including source switches. Each row describes a trace on this machine.

| Trace | Control | Automatic |
| --- | --- | --- |
| 540p MP4, 7 → 3.3 → 12 Mbit/s | 11.20 s waiting at source quality | 1.04 s on the acceptance run and 1.51 s on the production rerun. The former requested 480p at 10.3 s and the original at 61.9 s. |
| 1080p episode with audio conversion, 30 → 4 → 30 Mbit/s | 16.10 s at source resolution. Fixed 720p played through the restriction. | 2.19 s waiting on the acceptance run and 1.56 s on the production rerun. Used 720p during the restriction and restored 1080p. |
| 540p, three short dips to 2 Mbit/s | 0.26 s waiting at source quality | Stayed at 540p, zero waiting in the acceptance run. |
| 540p MP4, 7 → 1.2 → 12 Mbit/s over 90 s | 20.24 s waiting, longest interruption 10.54 s | 4.62 s waiting, longest 2.14 s. Chose 360p, then recovered through 480p to the original. |
| 165 s with repeated 5–6 s bandwidth recoveries | Three short recoveries before the sustained one | One downgrade at 11.3 s and one upgrade at 134.9 s, about 10 s after sustained recovery. |
| 1440p60, browser process group capped to one CPU equivalent with 2× browser CPU throttling | Dropped 1,749 of 2,769 sampled frames at 1440p | Stepped through 1080p and settled at 720p. Dropped 105 of 2,966 frames during 49 s at 720p. |

A separate frame-presentation trace used the same 7 → 3.3 → 12 Mbit/s schedule. Automatic had three gaps above 250 ms, with a maximum gap of 833 ms, across 1,983 presented frames. Prefer original had five such gaps and a maximum of 3,950 ms across 1,744 frames. Both 99th-percentile frame intervals were about 67 ms. The main improvement was shorter long freezes.

A fixed-rendition control on the 1.2 Mbit/s trace incurred 10.63 s of waiting at 480p. Fixed 360p played through the same trace. A pause and seek during speculative preparation preserved the requested position. A forced HTTP 422 during preparation left the source playing and the next compatible attempt succeeded. A buffered four-second outage caused no quality switch in the verification run.

Firefox exposed a background session recheck unmounting the player when the WebSocket repeatedly failed. The app now keeps an authenticated session mounted during revalidation. In the rerun Firefox switched from 540p to 480p and back, passed the old restart point and reached 81.7 s after 85 s of wall time. Five fresh Chromium LAN launches per mode measured median click-to-first-frame times of 156 ms for Prefer original and 168 ms for Automatic.

These checks used real media, shaped delivery and CPU throttling. Switching between direct playback and HLS can still interrupt presentation. Physical low-power devices and Safari native HLS require separate validation.
