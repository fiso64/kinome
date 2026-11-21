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
- A production report exposed a gap in the 60 ms SubRip measurement. On the 18 GiB *Chainsaw Man – The Movie: Reze Arc* HDD release, the old path read the movie before serving embedded text. A reference extraction took 100 s. All 35 tracks served indexed 30 s windows after the fix. Across the entire movie, 603 windows on the default English, forced English and Arabic tracks matched FFmpeg's full output for text, formatting and timestamps. With a warm filesystem cache, median/p95 HTTP times in milliseconds were 27/40, 1/3 and 25/30 respectively. Chromium continued presenting video with the subtitle response deliberately held, and Firefox displayed the expected cues after forward and backward seeks. For indexed DVD subtitles, two paused frames, including a reverse seek, matched the full-track rendering pixel for pixel. Whole-track extraction remains a fallback for other containers and sources without a usable subtitle index.
- Firefox accepted HEVC Main 10 with AAC for the same release, then fell back to video transcoding. At 34:06, the first media append carried only 676,473 bytes of a fragment that declared a 6,674,619-byte media box. The next fragment arrived before the remainder. The player now selects whole-fragment delivery before the first fMP4 request, while MPEG-TS still loads progressively. Three Firefox runs (from the start and twice from 34:06) each presented at least 340 frames with the original HEVC video and converted AAC audio. All 28 observed media appends contained complete MP4 boxes, with zero native media errors. A Chromium network check confirmed progressive delivery for the first TS fragment.
- Browser diagnostics were checked by truncating one HEVC + AAC fragment in Firefox at 34:06. The console recorded one recoverable append warning with the segment number, then the native MP4 parser error and the successful stereo AAC fallback. Chromium produced no player diagnostics during healthy direct play. An injected subtitle HTTP 503 and a failed playback-info request each produced one diagnostic at the appropriate severity.
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

## November 21 reliability retest

Firefox 158 reproduced the production freeze on `The.Hunger.Games.2012.BDRemux.1080p.mkv` using the deployed player bundle. DTS remux failed, then AAC conversion played the original H.264 picture. At 1664.417 s the player needed segment 713. The logged abort of segment 593 was an expected cancellation. Interrupting a partly parsed MPEG-TS segment could leave Firefox reporting a continuous 479–7606 s buffer after short, disjoint downloads. HLS went idle or kept loading the old position. The media element never completed the seek.

| Reproduced failure | Fix and verification |
| --- | --- |
| Firefox hangs after dragging across partial TS downloads | Reset the parser when leaving a partly processed fragment. Reopen the same rendition if a seek stops making progress. The final build passed 64 seek bursts at 25 Mbit/s with 65 ms added media-request latency. Each required a presented picture over 1.2 s past the target. A stopped loader recovered while paused, and a 9.5 s active transfer completed without a restart. |
| Fresh HLS resume at an exact segment cut can unnecessarily transcode video | Let HLS place its initial seek after both tracks have appended. The audio-conversion route kept the original picture at all five previously failing cuts in the AAC fixture. |
| Chrome repeatedly fetches the same segment when seeking AVI with copied MP3 | In three constrained runs, Chrome lost audio coverage between 42.710 and 43 s. Timestamped fragmented MP4 passed all 15 repeat seek checks. All 1,149 MP3 packets in a 30 s extract matched the source in order. The server omits an unavailable remux attempt on containers without a supported seek index. |
| Firefox shows a still on a valid delayed-video MP4 | The correct first picture was at 4 s. Firefox stamped it at 500 s and retained that clock across source reloads. Kinome checks the opening picture before applying a saved position, keeps any intentional audio lead-in, then opens a remux on a fresh element if the clock is wrong. Removing FFmpeg's input seek at zero preserves leading audio. Resumes at 0, 2, 20, 305 and 525 s passed. A matching-timescale control stayed in direct play. [Mozilla bug 2082877](https://bugzilla.mozilla.org/show_bug.cgi?id=2082877) |
| Switching audio immediately after pausing restarts playback | Read the current pause state before replacing the source. Both browsers stayed paused. Switching reference tracks produced the expected 440/880 Hz tones. Three Firefox soundtrack changes on the movie took 1.13–1.31 s. |
| Temporary HTTP 503 leaves the player at an error until manual retry | Reopen the same rendition with bounded backoff and retain the requested position. Chrome resumed direct MP4 after 6 and 16 s outages, and HLS after 35 and 90 s outages, without a browser online event. |
| Automatic stays at source quality on a reachable server when the browser reports offline | Use measured buffer growth as evidence of delivery. With a 65 → 5 → 95 Mbit/s packet-shaped route, the old build waited 7.90 s. Two patched runs waited 2.07 and 1.94 s and restored 1080p. A real offline/online transition also recovered direct, remuxed and transcoded playback, including a paused seek. |

Median click-to-first-picture time in Google Chrome 155, alternating production builds in fresh browser contexts. Five trials per cell, seven for AVI. The constrained profile used 4× CPU throttling, 85 ms latency and 10 Mbit/s downstream.

| Source and active mode | LAN, before → after | Constrained, before → after |
| --- | ---: | ---: |
| H.264/AAC MP4, original | 94 → 93 ms | 586 → 603 ms |
| MKV with alternate AAC, remux | 177 → 177 ms | 1193 → 1220 ms |
| AVI, 360p with copied MP3 | 275 → 485 ms | 2146 → 2413 ms |
| Hunger Games, 1080p with converted audio | 626 → 544 ms | 4537 → 4375 ms |

- At 18 Mbit/s with 40 ± 12 ms egress latency and 0.35% packet loss, Firefox on one CPU completed all 35 target checks across seven files. Chrome completed 30 across six. On the movie, all 30 Firefox and 24 Chrome real pointer-drag trials passed, including while paused.
- Across two extracts around the reported seek positions, all 1,556 decoded video frames matched the source hashes in order. All 271 sampled 200 ms audio windows correlated above 0.8 with the source, with median alignment errors of 0.1 and 0.5 ms. mpv and VLC independently decoded the same HLS audio conversion and sought to both positions.
- Ten paused subtitle comparisons per browser showed visible pixels at expected cues across text, ASS, PGS and VobSub. Delaying five subtitle requests by 4.2 s left pictures advancing. Switching subtitles off during the delay left no stale overlay. Concurrent direct reads from the SSD and HDD matched local bytes in all 112 checks.
- Firefox and Chrome each completed five seek checks on each of 16 files, covering H.264, HEVC, AV1, VP9, MPEG-2 and MPEG-4 Part 2. In a separate queue test each browser opened 12 selections while seeks were outstanding, including two selections deliberately replaced before playback. The ten retained selections all presented moving pictures.
- On the delayed-video MP4, Firefox sometimes omitted the opening frame callback entirely under load. The player now keeps watching after startup and recovers if a visible, buffered video is past its first picture for two seconds without presenting it. Across 25 observed element replacements, the selected subtitle, volume, mute, speed and requested pause state survived. A Chrome control stayed in direct play. With callbacks deliberately withheld, Chrome recovered visibly and waited through a simulated hidden-tab interval before attempting recovery.
- For cold starts, the same 49 MiB MP4 had zero resident file pages before each of 24 trials. Median SSD/HDD click-to-picture times were 169/719 ms for original playback and 597/963 ms for remux in Chrome. Firefox measured 416/294 ms and 552/624 ms respectively. Four concurrent HLS viewers completed all 20 pairs of duplicate segment requests while cancelling obsolete reads. The idle sessions expired after roughly one minute.
- Direct AAC, remuxed AAC and copied MP3 playback produced no PCM silence lasting 16 ms or more in ordinary 48 s tone runs. Under a one-core limit, Chrome dropped frames and output measurable silence despite buffered data. Across four Firefox replays of the movie at 1644–1689 s, drops varied from 1 to 155. In two separate comparisons of the same scene, Kinome HLS dropped one and zero frames. Bare HLS dropped zero in both. The tests used headless browsers with simulated device constraints.
- Two 30-minute playbacks shared the host with the other stress tests. Firefox advanced 1,794 s through the reported movie with its original H.264 picture. Chrome advanced 1,782 s through the 4K Reze conversion in Automatic. Every 30 s sample showed advancing pictures. Under load the longest individual presentation gaps were 3.74 s and 2.12 s respectively. Chrome reached 240p during contention and ended at 360p.
- The rotating endurance run completed 55 sessions across 12 files with seeks, pauses and track switches. Across 93.6 minutes of sampling, the harness detected zero sustained freezes. Two earlier Firefox attempts failed to open the library in the harness. Both files were rerun successfully. The final production build, type checks and all 634 tests passed. The redeployed local test instance played and sought the direct MP4, the AVI conversion and the reported movie.

Raw browser traces, packet hashes, screenshots and timing records are under `/mnt/storage/kinome-playback-audit/reliability-nov21`.

## November 21 server contention

The local production-build comparison used four cores of an Intel i5-8500 for Kinome and its FFmpeg workers and the other two for clients. Both the database and transcode directory were on SSD. Chrome 155 measured item click to first presented frame and seek to the first picture at the target, then checked that pictures advanced at least another 0.7 s. Each normal workload ran twice in opposite file order, with three seeks per file. The direct-play comparison used identical 49 MiB MP4s on SSD and HDD, evicted from the file cache before each trial. The network was local.

The initial workload comparison used the build from the reliability retest. Background hardware sessions independently transcoded the same 1080p HEVC episode at disjoint positions, each consuming segments in real time with about 9 s of reserve. In the disk stress case, four competing readers issued uncached random 64 KiB reads across two movies on the same HDD. Median HDD utilization reached 100%.

| Foreground seek, median ms | Idle | Two VA-API clients | Four VA-API clients | Random HDD reads | Four VA-API + random HDD reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original MP4 on SSD | 55 | 59 | 60 | 58 | 65 |
| Original MP4 on HDD | 64 | 61 | 64 | 474 | 444 |
| HDD MP4 with alternate AAC, remux | 146 | 138 | 137 | 506 | 539 |
| Hunger Games, copy H.264 and convert DTS | 554 | 653 | 729 | 1,393 | 619 |
| 1080p HEVC episode, full video transcode | 320 | 462 | 903 | 615 | 316 |

- All 180 Chrome seek checks across these workloads and the idle recovery run passed. Firefox 158 completed 30 additional seek checks on the movie and an AVI conversion across disk contention, combined load and recovery. All four background VA-API timelines kept their buffers in the combined test.
- On the high-bitrate Hunger Games remux, three 30 s observations immediately after seeking under combined load advanced 5.6, 15.6 and 29.4 s. In the first two, the audio-conversion route repeatedly ran out of buffered media while the next segment loaded. The third reached full video conversion. Under that load, the original movie's three audio switches took 1.0–2.8 s, Reze's took 1.9–4.1 s, and four embedded subtitle requests completed in 0.12–1.15 s.
- A cold original-file response could block unrelated requests on the HTTP thread. In eight alternating trials per build, reading four 4 MiB HDD ranges drove an independent authenticated endpoint's p95 to 574–691 ms. Serving original files and subtitle assets with asynchronous reads reduced that to 3.3–3.6 ms. The 16 MiB transfers took 2.23–2.55 s with the fix and 2.38–2.87 s before. All 80 byte comparisons, including full-file and final-byte requests, matched. Freshly generated HLS segments retain their existing fast path.
- The final implementation passes Bun's `node:fs.createReadStream` directly to `Response`. Returning a sliced `Bun.file`, its stream, or that stream through a Web Stream adapter all delayed the HTTP thread on cold reads. The change costs peak cached loopback throughput. The median for one reader went from 5,154 to 2,750 MiB/s and the total for four readers went from 8,470 to 2,824 MiB/s. Eight clients paced at 4 MiB/s each completed in 12.0 s on both builds. Server CPU time rose from 0.10–0.11 to 0.82–0.90 core-seconds for the combined 384 MiB. Eight stalled clients stopped reading ahead and released all eight file descriptors within 7 ms of disconnect.

Software encoding of the same episode gave a different capacity limit. These are foreground full-video-transcode times. With zero background sessions there was one launch and three seeks. With two or four background sessions there were two launches and six seeks per cell.

| Background software transcodes | Median server-core utilization | Click to picture | Median seek | Buffer exhaustion across background viewers |
| --- | ---: | ---: | ---: | --- |
| 0 | 13% | 0.78 s | 0.76 s | — |
| 2 | 85% | 1.41 s | 1.02 s | 0 s each |
| 4 | 99.5% | 2.04 s | 2.25 s | 0, 0, 0.99 and 7.33 s |

- Two browser viewers started independent 1080p software encodes in 1.31 and 1.50 s with two additional HLS clients active. Both passed three simultaneous seeks at different positions. After closing one browser, the other presented another 10.01 s of video in 10 s.
- Four unrelated CPU busy loops and a separate 40 MiB/s sequential HDD scan each passed all 15 foreground seek checks. Median direct HDD seeks were 48 and 58 ms respectively. The sequential scan exercised a much lighter disk workload than the random reads.
- Six software 1080p peers saturated all four cores. In two paired 100 s browser runs with peers stopped partway through, Prefer original advanced 89.2 and 87.9 s. Automatic advanced 85.6 and 88.8 s. Automatic reached 480p on the first run and 720p on the second, then returned to 1080p both times. Preparing and attaching lower renditions took time on the overloaded encoder. Automatic showed no consistent playback-time advantage here.
- Four clients independently requested four different titles, including the 4K HDR Reze movie converted to 1080p. All four delivered 97–98 s of media without exhausting their buffers while a fifth browser played Hunger Games. With another four random HDD readers active for the first 38 s, that browser advanced normally at a previously exercised position and kept the original H.264 picture.
- In a separate recovery run, three previously untested seek positions on Hunger Games took 2.29, 2.55 and 3.10 s to reach a moving picture under combined contention. The browser played through the following 70 s, including the removal of disk and transcode load halfway through. Across the runs, storage contention produced intermittent, scene-dependent underruns.

Raw workload drivers, per-viewer segment delivery, host samples, browser presentation timings and before/after measurements are under `/mnt/storage/kinome-playback-audit/server-load`.
