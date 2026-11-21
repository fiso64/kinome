# Filename parsing proposal

**Status:** implemented. The TV scope boundaries below describe the deferred work.

Start with a small, context-aware TypeScript parser at the automatic metadata lookup boundary. It should produce a useful TMDB query for both files and release folders, retain the year as a separate hint, and surface ambiguity. Use the same token rules for TV structure in a second step. Keep source shadowing and move reconciliation on their current rules until they have their own migration and regression coverage.

## Agreed product decisions

- Prefer a credible title match with the exact year. Consider a one-year difference only when there is no credible exact-year match and there is a unique exact-title candidate within that window. For an ambiguous bare year, try the intact title first.
- Prefer a meaningful movie folder name. A generic folder can borrow its sole feature's title after excluding extras, or use a title and year that its eligible feature files agree on. Leave competing titles unresolved.
- Honor an explicit TMDB ID from the item's name when its type is known and there is no conflicting ID. Existing matches and manual locks take precedence.
- Existing items follow the normal scan lifecycle. Keep stored matches and previous lookup state. Do not schedule a backfill, reset failed attempts, or initiate a rematch for this change. Use the new parser when the normal workflow calls for automatic matching.
- In Smart TV assignment, keep clear episode numbers and leave ambiguous files browseable. A duplicate claim should not renumber unrelated episodes. Keep alphabetic fallback for folders that lack usable numbering evidence, and keep explicit Alphabetic mode.
- Recognize explicit episode coordinates, multi-episode ranges, and absolute episode numbers in the TV parsing pass. Defer automatic show discovery for loose files in mixed libraries, representing one file as multiple episode entries, and mapping absolute episode numbers across seasons. See [Agreed TV scope boundaries](#agreed-tv-scope-boundaries).

## Kinome before the change

- Automatic identification passed `item.name` to `provider.match`. That can be a bare title, a full torrent release name, or a filename including its extension. Phase 2 does not supply a year derived from the name. The TMDB adapter takes the first result. It can send a year parameter for movie and TV searches. Its mixed search filters out people and does not use the year. Manual search already accepts a year and a TMDB ID. [Metadata orchestration](../src/main/services/metadata.service.ts) · [TMDB adapter](../src/main/services/metadata-provider.ts) · [TMDB requests](../src/main/services/retriever.service.ts)
- The tested `parseTitle` utility strips some technical words anywhere in the name, recognizes seven video extensions, and discards a trailing bracketed year. It has no production caller. The import in the retriever is unused. Wiring it in unchanged would still lose years and could remove title words such as the leading `4K` in `4K Adventure`. [Title parser](../src/main/utils/title-parser.ts) · [Title tests](../src/main/utils/title-parser.test.ts) · [Supported video extensions](../src/shared/local-media.ts)
- TV structure runs for known shows. Its per-file parser picks the first pattern, then smart mode looks for one pattern family across siblings and rejects duplicate episode keys. Together those decisions can renumber the entire folder by natural sort. Loose files default to season 1 in a flat show. In a mixed show they have no implicit season. The TV service still processes loose root files in mixed shows, despite the older spec saying it skips them. [TV parser](../src/main/utils/tv-parser.ts) · [TV structure service](../src/main/services/tv-show.service.ts) · [Existing TV spec](../spec/backend/tv_parsing.md)
- Season parsing also controls which lower-priority source folders get traversed. Season and episode parsing both participate in a late move-reconciliation fallback that can reuse an existing item ID. A new lexical hit can therefore hide a folder or reattach account state to a different file. Those call sites need stricter input and their own tests before adopting broader rules. [Source shadowing](../src/main/services/filesystem.service.ts) · [Move reconciliation](../src/main/services/scan-reconciliation.service.ts)

## Jellyfin and Kyoo

| | Jellyfin | Kyoo |
| --- | --- | --- |
| Unit of parsing | Naming helpers inspect video items, season folders and episode paths. Server resolvers supply library type and parent context. | The scanner starts from each video path and builds a guess with title, kind, years, episode coordinates and release information. |
| Title and year | The movie video resolver extracts a year and applies release cleanup. Movie resolution can use the containing folder for a single organized movie. Provider IDs have separate path rules. The TMDB movie provider uses the parsed year in search and ranks results. | GuessIt supplies typed matches and source spans through Rebulk. Kyoo enables episode-number preference, excludes language matching, and supplies known anime titles when available. Scanner requests use a guessed year. The TMDB provider prefers matching years and exact names. |
| Episodes | Ordered expressions cover explicit season and episode, `2x03`, named and optimistic patterns, absolute numbers, dates and ranges. The resolver can filter by expression category. Its alternate-version grouping excludes optimistic matches because grouping can collapse distinct entries. | Custom rules address numeric titles, one-digit episodes after known titles, directory titles, ordinal seasons, conflicting years and seasons, and duplicated claims from parent packs. Filename title, season or episode claims beat duplicate directory claims. AniList/AniDB and TVDB mapping logic runs after parsing when available. |
| What transfers | Separate release cleanup, year and contextual episode interpretation. Isolate weak guesses from identity changes. Use exact organized-folder semantics before borrowing a parent title. | Keep evidence attached to the text span and path component that supplied it. Use the known show name as context for anime. Keep absolute numbering distinct from provider season coordinates. |

Jellyfin references at `d05a80ced13a36a5d1fc328f6c83775d4b6021b4`. [Video resolver](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Naming/Video/VideoResolver.cs) · [Movie resolver](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Server.Implementations/Library/Resolvers/Movies/MovieResolver.cs) · [Season parser](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Naming/TV/SeasonPathParser.cs) · [Episode expressions](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Naming/Common/NamingOptions.cs) · [Episode parser](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Naming/TV/EpisodePathParser.cs) · [Version grouping](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/Emby.Naming/Video/VideoListResolver.cs) · [TMDB movie provider](https://github.com/jellyfin/jellyfin/blob/d05a80ced13a36a5d1fc328f6c83775d4b6021b4/MediaBrowser.Providers/Plugins/Tmdb/Movies/TmdbMovieProvider.cs)

Kyoo references at `8630d5c470e405805f1c2dcbcca588a7d7a93a51`. [GuessIt wrapper](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/identifiers/guess/guess.py) · [Overrides and examples](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/identifiers/guess/rules.py) · [Identification](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/identifiers/identify.py) · [Anime mappings](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/identifiers/anilist.py) · [Scanner matching](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/fsscan.py) · [TMDB ranking](https://github.com/zoriya/Kyoo/blob/8630d5c470e405805f1c2dcbcca588a7d7a93a51/scanner/scanner/providers/themoviedatabase.py)

Jellyfin is the stronger starting point for title and year rules in this corpus. Kyoo is the stronger reference for fansub context and separate episode-order mapping. Importing Jellyfin's C# scanner or running Kyoo's Python stack would still leave Kinome to define its folder-first matching and reconciliation policy. Start with the subset below. Revisit a dependency if a larger corpus shows persistent gaps that a maintained parser covers.

## Proposed rules

### 1. Title, release year and provider lookup

1. **Separate the path from the guess.** Parse a basename with its file or folder kind. Strip only an actual supported video extension on files. Parse using original separators and Unicode-aware boundaries before collapsing dot and underscore separators in the query. Preserve meaningful punctuation, accents, scripts, and original case. Keep the physical name, item ID, and user-visible title fields independent of the search query.
2. **Find a release suffix with positive evidence.** Recognize a compact vocabulary for resolution and source (`2160p`, `1080i`, `WEB-DL`, `BluRay`, `BDRip`, `HDTV`, `REMUX`) and codecs, channel counts, HDR, bit depth and service names in that suffix. Once a strong token starts a release tail, strip the rest from the query. Extend backward over adjacent, recognized release modifiers such as `IMAX` or `PROPER` only when the remaining context supports it. Standalone `HDR`, `DC`, `NF`, `FLAC`, `Part II`, a hyphenated word, and a bare digit are weak evidence. Preserve those in a title unless other tokens establish a release suffix. Strip a final group such as `-GRP` only as part of that tail. Handle edition labels from a short list in the same pass. Recognize brackets, parentheses, a separating dash, or a label immediately after a bracketed year.
3. **Protect bracketed titles.** A leading bracket group may be a fansub label or part of the title. Remove a group when corroborated by a known show name, an episode marker plus fansub layout, or a title and separate year plus release suffix. If stripping the group leaves only a year or other metadata, keep it as title text. Keep unknown brackets inside titles. Treat checksums as suffix markers only in release context.
4. **Extract a separate year.** Accept a single year in matching parentheses or brackets after a nonempty title and before recognized release decorations. Accept an unbracketed year as the rightmost title-adjacent year before confirmed release metadata or a TV season-pack suffix. A release year should fall in a plausible movie/TV window from 1888 to the scan year plus two. Bare trailing years without other evidence produce a lower-confidence `title + year` alternative. Try the intact title first. Thus `Blade Runner 2049` stays intact, while `Heat 1995` can still look up `Heat` with a 1995 hint if there is no credible intact-title match. A year token in `2001 A Space Odyssey`, `1917` or `2012` stays title text. A calendar date, an episode coordinate, a bracketed provider ID and a year each claim separate spans.
5. **Treat a series pack as title context.** Extract the show name and year from `Dark.2017.S01-S03.COMPLETE.1080p`, separately recording that its scope is a pack. Recognize an ordinal season phrase such as `1st Season` as structural evidence when it appears in a clear TV release tail. Preserve season-like phrases in ordinary titles absent that context. Existing known series names can confirm a prefix and protect numeric titles such as `86` and `24`.
6. **Choose the query at the existing logical entry point.** For a movie folder, prefer the folder candidate. Consider a child filename only if the folder name is uninformative and the eligible feature files give one consistent title and year, or there is a single clear feature after excluding extras. A trailer, sample, unrelated file, or competing title cannot name the folder by itself. For a standalone movie file, use the file candidate. In a known show or season, file markers control coordinates. Borrow the established show title from context for generic names such as `Episode 05.mkv`. Walk only already-known structural ancestors within the configured root. Keep type locks, folder hints and existing discovery rules authoritative. Leave automatic recognition of loose episodes in mixed libraries for a separate classification change.
7. **Use title and year in TMDB matching.** Keep direct lookup of a syntactically valid `[tmdbid-123]` or `{tmdbid=123}` local to the candidate entry, after stored IDs and manual locks. Direct lookup requires a known item type because numeric IDs can overlap across types. Conflicting local IDs block ID-based auto-selection. IMDb and TVDB tags can be parsed independently, with lookup deferred until the corresponding provider path is defined. For movie or TV queries send the year where supported. For mixed results, rank the relevant types in the single response by title and year. Compare provider title and original title using the same comparison normalization. Rank credible exact-year results ahead of nearby years. If no credible exact-year result is found, allow a one-year difference only for a unique exact-title candidate. Initial release, festival and regional dates can differ by a year. Larger differences leave a clearly year-marked item unresolved. If equally plausible remakes remain, keep the item available for Fix Match. Preserve existing IDs and matches on rescan.
8. **Keep retries bounded.** Search the best query first and try at most one distinct fallback on an unresolved entry. Use this for cases such as a conservative bare-year alternative or a provider search with a restrictive year. Coalesce identical in-flight queries within one enrichment pass when the type, year and query agree. Surface the chosen rule and result in existing debug diagnostics. This fallback is part of a normal new lookup. Keep the existing `lastRefreshedAt` eligibility guard for previously attempted matches.

### 2. Season folders and episode candidates

Use the most specific evidence first. Return candidate coordinates and their kind, with the matched span. Resolve ambiguous cases at the structure service using an already established show and its siblings.

| Priority | Evidence | Interpretation |
| --- | --- | --- |
| 1 | `S02E05`, `S02.E05`, `S02_E05`, `Season 2 Episode 5`, `2x05` | Explicit coordinates. Allow customary punctuation and a terminal release revision such as `v2`. Demand a valid ending boundary. Retain the legacy compact `ShowS02E05` spelling. Technical dimensions such as `1920x1080`, bracketed aspect ratios such as `[4x3]`, codec words, and `S02E05X` do not produce coordinates. |
| 2 | `S02E05E06`, `S02E05-E07`, `S02E05-S02E07`, `2x05-2x07` | Recognize a forward range or consecutive explicitly marked episodes. Validate both endpoints and the season. An unrelated second coordinate, a cross-season span, or a reversed range yields a conflict. A bare numeric episode title and `-1080p` stay outside the range. Preserve the candidate shape for future multi-episode support. |
| 3 | `Episode 5`, `Ep_05`, `E05` | Strong episode number with no season of its own. Inherit the nearest established season under the same show. A manually locked season folder overrides filename coordinates during assignment, as it does today. |
| 4 | `[Group] Show - 1089v2 [1080p]`, `Show 6`, `002`, `01 - Pilot` | Weak or absolute candidate. Require an exact known show prefix or a consistent sibling series under a known show/season. For bare numbers, require a known season plus corroboration from other filenames or provider episode data. Keep up to four digits in a supported absolute format. `86 - Eighty Six - 05` uses the final delimited number with the show context. An isolated `Part 2` remains unknown. |
| 5 | `News.2024.02.29` | A valid calendar date within a known episodic context is a separate candidate. Calendar-invalid dates, timestamps and dimensions do not fall through to number guessing. Use date-based provider assignment only once the lookup has an explicit contract. |

- Accept single-season folder labels `Season 02`, `Season_02`, `S02`, and release forms such as `Show.S03E01-E14.1080p`. A pack crossing seasons does not have a single season number. A numbered pack directory remains browseable as a physical folder. A bare numeric directory name needs established context and should be deferred initially. Match extras and specials by exact normalized name or a clearly delimited release marker in a known show. Preserve the existing special-folder skip and manual overrides. Explicit `S00E01` or a manually designated specials folder can use season 0 without promoting every `Specials` folder to a season.
- Resolve strong evidence per file across mixed spellings. Use sibling consensus to corroborate weak guesses and identify repeated suffixes. Keep a single decimal digit as a candidate and preserve current collision-safe shared-suffix detection at folder scope initially. A true fractional episode has no guaranteed corresponding TMDB episode.
- When two files claim the same episode, preserve both physical entries and retain their conflicting claims locally. Never renumber an unrelated episode because of those two files. Decide multi-version grouping separately. Likewise, preserve distinct season claims when two folders claim season 2. Do not relabel the second as season 3.
- Keep explicit **Alphabetic** strategy as an operator override. For **Smart**, allow natural-order fallback when a known season has no usable episode candidates and looks like a plain list of episodes. Exclude samples, trailers, and unresolved date, range or absolute candidates from positional numbering. In a partially understood folder, leave individual unknown files browseable. In a flat known show, season 1 remains the mechanical fallback for ordinary season-relative names and eligible alphabetic ordering. An absolute number such as `1089` is insufficient to fetch TMDB season 1 episode 1089. Leave it unresolved unless the show context establishes a season-relative number. In a flat show, an absolute release with the known show title can use season 1 within its known episode count. Use the first coordinate of a valid combined release for the current scalar episode field. Daily episodes remain unassigned. Existing records follow the same scan lifecycle as other library items.

### Agreed TV scope boundaries

| Filename evidence | In the parser and TV structure pass | Deferred product behavior |
| --- | --- | --- |
| `Breaking.Bad.S02E05.mkv` directly under a mixed library root | Recognize the explicit season and episode. Use it during structure sync for files already under a known show, including files directly inside the show folder. | Discover or create a show and associate a loose file outside any known show with it. |
| `Show.S02E05-E07.mkv` | Recognize the range and make the combined file playable from its first episode entry. | Make the same file represent three distinct episode entries. That needs rules for episode navigation, starting offsets where known, and watched state. |
| `[Group] One Piece - 1089v2.mkv` | Recognize absolute episode 1089. Where context verifies season-relative numbering, assign an ordinary episode as usual. | Convert series-wide absolute numbers to provider season and episode coordinates across seasons. That needs an explicit, trustworthy mapping. |

## Existing rules that need explicit handling

| Existing behavior | Proposed action |
| --- | --- |
| `parseTitle` globally deletes individual technical-looking words and drops a year. Its public tests cover the utility independently of automatic matching. | Replace the unused utility with the new title candidate owner when wiring the automatic provider path. Preserve meaningful safeguards such as numeric titles and dot-number folder names. Add an orchestration test that checks the TMDB query and year. Keep manual search as entered. |
| `parseSeasonFolder` can read season 1 from `S01-S03` or season 0 from any text containing `Specials`. TV structure skips certain special folder names, source shadowing has its own special-folder precheck, and reconciliation calls the parser directly. | Make structural context explicit. Keep broader rules out of shadowing and move matching initially. Later migrate the callers to share lexical candidates with separate acceptance policy. An episode move must still satisfy the current absent-path, one-claim and fingerprint constraints. An explicit coordinate with conflicting evidence is ineligible. |
| Smart episode matching uses one regex family, and duplicates can push the whole group to alphabetic order. Smart season assignment can also fall back after duplicate season labels. | Keep the collision decision local. Compare old and new assignments on partial, duplicate and multi-source libraries before using the new logic on existing entries. Retain operator locks, explicit alphabetic strategy and already confirmed provider matches. |
| Show structure can interpret an explicit filename season differently from the physical folder. A locked folder season is forced when applying the episode map. | Maintain that precedence. Record disagreement as parser evidence. Never move a physical file based on the interpretation. |
| Existing scan and provider flows use stable physical identity, successful provider IDs, and persisted last-attempt state. | Change the guesses used for enrichment first. Keep exact paths, item IDs, locks, shadow decisions, saved playback defaults and watch state under their existing owners. Test repeated scans and moves across roots before changing identity-sensitive consumers. |

## Experiment

I labeled 67 development cases and froze a scratch prototype. I then added 20 challenge cases without tuning the prototype. The later set is an adversarial check chosen after inspecting the rule categories. It is neither a random sample nor a blind measure of library accuracy. Paths are constructed torrent-style, fansub, organized and negative examples. No media, live provider calls, or personal library scan were required.

- **Current** measures the raw automatic TMDB query for titles and the actual Kinome helper output for episode and season tokens. Every raw movie filename includes its extension, so this exact-query metric scores those rows zero. TMDB can still return a match for a noisy query. **Old cleaner** substitutes the existing title helper and leaves the other categories the same.
- **Jellyfin** runs the pinned `VideoResolver.ResolveFile/ResolveDirectory`, `EpisodePathParser.Parse` with default expression selection and `SeasonPathParser.Parse` with TV aliases and numeric folders enabled. Folder cases, including show packs, are scored through the video parser as release-title extraction probes. Sidecar exclusion, provider IDs, extras, inheritance and type eligibility can be handled by other Jellyfin resolver layers. The upstream naming suite ran 704 tests with zero failures. The local .NET 10 SDK needed `-p:RunAnalyzers=false -p:WarningsNotAsErrors=CS9057` for an analyzer version mismatch.
- **Kyoo** runs the pinned GuessIt wrapper and its Rebulk rules with GuessIt 4.4.0, Rebulk 6.0.1 and the fixed expected-title list `One Piece`, `86`, `Asobi Asobase`. It loads Kyoo's unmodified title-normalization function without starting the scanner. AniList remapping, request processing and live provider ranking are outside the experiment.
- **Prototype** runs a small scratch Bun evaluator for title, episode and season lexical ideas. It skips several proposed steps, including provider IDs as a scored output, alternative search queries, playlist or media grouping, database writes, and integration with Kinome's scanner. Its code stayed outside the repository.
- Titles require both title and year to agree. Comparison folds case, repeated whitespace, dots and underscores. Episodes compare season and number, range and date where present. A missing season can inherit an unambiguous `Season N` test parent. Kyoo's list is projected to its first year or first-to-last episode for comparison. Blank results score only on labeled unknown cases. Raw episode helpers can recognize coordinates in a subtitle path. Full scanners have separate eligibility checks. These are exact extraction comparisons for our contract, not server match rates.

| Cases | Current | Old cleaner | Jellyfin | Kyoo | Prototype |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development, 67 | 26 | 30 | 53 | 51 | 66 |
| Challenge, 20 | 3 | 3 | 13 | 15 | 11 |
| All movie filenames, 29 | 0 | 5 | 27 | 18 | 25 |
| All release/title folders, 8 | 2 | 1 | 5 | 6 | 7 |
| All episode paths, 38 | 20 | 20 | 26 | 31 | 33 |
| All season folders, 12 | 7 | 7 | 8 | 11 | 12 |
| Total, 87 | 29 | 33 | 66 | 66 | 77 |

The challenge group matters more than the total. The frozen prototype missed `IMAX` in development and missed nine challenge cases. It dropped the title in `[REC]`, left `PROPER` and `(Extended Cut)` attached, missed `1st Season` and bare `002`, treated repeated full endpoint markers as conflicts, accepted `S02E05X`, and lost the decimal in `02.5v2`. These failures motivate the prefix guard, release-modifier rules, endpoint validation and typed candidate rules above. The implementation tests now cover all 87 extraction labels. The table reports the frozen research prototype for comparison. Some labels, such as treating `Heat 1995` as the primary query, deliberately prioritize safe ambiguity handling. A credible provider result may support a different final match.

I also ran current Kinome folder consensus against four episode sibling sets and one season sibling set. The frozen evaluator returned lexical candidates only. The last column specifies how the future structure service should resolve them.

| Scenario | Observed current assignment | Required assignment |
| --- | --- | --- |
| Season 3 contains `Show.S03E07`, `Episode 8 - Title`, `Show.3x09`, `Sample.1080p` | Natural sort assigns 1–4, including the sample | 7, 8, 9. Keep the sample available as an extra. |
| Two S01E07 encodes plus S01E08 | Renumbers the three files 1, 2, 3 | Preserve both episode 7 claims. Keep episode 8 as episode 8. |
| S02E09, E10 and E11 in the same explicit spelling plus `mystery.mkv` | Keeps 9–11 and omits the unknown | Keep 9–11 and the unknown as a browseable file. |
| S01E07.5, S01E08.5, S01E09 | Shared suffix heuristic assigns 7, 8, 9 | Preserve the existing collision-safe suffix behavior initially. |
| `Season 2`, `Show.S02.COMPLETE.1080p`, `Season 3` | Explicit season map is empty after the duplicate | Preserve both physical season 2 folders and the independent season 3 claim. |

## Implementation and acceptance

1. **Title and year first.** Implement pure name analysis and route logical-entry identification through it. Add mock-provider tests for credible year matching, typed and mixed results, remakes, locks, prior lookup eligibility, and conflicting folder/file evidence. Keep exact release names browseable. Run the unchanged corpus and a fresh challenge set before changing the TV parser. The release-folder design needs integration fixtures such as a generic movie folder containing one feature and a trailer, a mixed folder with two titles, and a clean show with nested release packs.
2. **TV assignment second.** Implement lexical candidates and local conflict resolution in the existing TV structure owner. Cover the sibling cases above, mixed root and season files, locked season overrides, known extras, and partial packs. Add explicit fixtures for each challenge failure. A failed guess should leave one file or folder unresolved while unrelated entries still get their correct numbers.
3. **Review identity consumers separately.** Before any adoption in filesystem shadowing or reconciliation, compare resolutions on two prioritized roots with overlapping season numbers, missing files, same-number different encodes, and cross-season packs. Run repeated scans and verify no logical ID churn, duplicate relocation, or newly hidden branches.
4. **Check the cost at the entry point.** Parse only title discovery entries or already-enumerated TV names. Inspect each relevant component once with bounded ancestor use and fixed, compiled expressions. Use maps keyed by coordinates to reduce sibling collision checks to one pass. Reuse existing scan batches and avoid extra directory walks, file probes or provider calls on the usual successful path. Use deterministic mocked provider fixtures to count requests. Measure a warm parser pass on a representative synthetic library and a scan with the test data before merging. This experiment did not measure end-to-end scan runtime.

## Implementation measurements

The parser benchmark used Bun on Linux, with one warmup and the median of seven runs. Each workload processed 100,000 names in memory. The previous parser took 34 ms on explicit episode names and 1,380 ms on mixed styles that triggered its alphabetic fallback. The new parser took 54 ms and 246 ms respectively. In the mixed workload it assigned 75,000 explicit episodes and left the 25,000 unmatched filenames unnumbered. Release title and year extraction took 383 ms for 100,000 names. These measurements exclude SQLite, filesystem reads and provider traffic.

On a warm rescan of the local fixture library, the backend took 36 ms from starting the source scan through metadata maintenance. Both fixture shows kept their existing episode assignments. This measures a small unchanged library with no new provider lookups.

## Labeled corpus and observed outputs

The implementation passes all 87 extraction cases. Provider integration tests use deterministic responses to verify exact-year preference, the one-year fallback, existing lookup eligibility, and the request budget.

Each row records the intended extraction and what each helper returned. M is a movie file, F a title or release folder, E an episode path, and S a season folder. A dash means unknown. `?` means the episode has no season in the parsed context. Movie and folder results use `title @ year` when a year is present. Rows 68–87 are the challenge set.

<details>
<summary>All 87 cases</summary>

| # | Kind | Path | Expected | Current | Old cleaner | Jellyfin | Kyoo | Prototype |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | M | `Movies/The.Matrix.1999.2160p.UHD.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-GRP.mkv` | the matrix @ 1999 | the matrix 1999 2160p uhd bluray remux hevc dts-hd ma 5 1-grp mkv | the matrix 1999 2160p remux dts-hd ma 5 1-grp | the matrix @ 1999 | the matrix @ 1999 | the matrix @ 1999 |
| 2 | M | `Movies/Spirited.Away.(2001).1080p.BluRay.x264.DUAL-GRP.mkv` | spirited away @ 2001 | spirited away (2001) 1080p bluray x264 dual-grp mkv | spirited away (2001) dual-grp | spirited away @ 2001 | spirited away @ 2001 | spirited away @ 2001 |
| 3 | M | `Movies/2001.A.Space.Odyssey.1968.2160p.HDR10+.HEVC-GRP.mkv` | 2001 a space odyssey @ 1968 | 2001 a space odyssey 1968 2160p hdr10+ hevc-grp mkv | 2001 a space odyssey 1968 2160p hdr10+ -grp | 2001 a space odyssey @ 1968 | 2001 a space odyssey @ 1968 | 2001 a space odyssey @ 1968 |
| 4 | M | `Movies/1917.2019.1080p.BluRay.x264-GRP.mkv` | 1917 @ 2019 | 1917 2019 1080p bluray x264-grp mkv | 1917 2019 -grp | 1917 @ 2019 | 1917 @ 2019 | 1917 @ 2019 |
| 5 | M | `Movies/2012.2009.1080p.BluRay.x264-GRP.mkv` | 2012 @ 2009 | 2012 2009 1080p bluray x264-grp mkv | 2012 2009 -grp | 2012 @ 2009 | 2012 @ 2009 | 2012 @ 2009 |
| 6 | M | `Movies/Blade.Runner.2049.2017.2160p.REMUX-Group.mkv` | blade runner 2049 @ 2017 | blade runner 2049 2017 2160p remux-group mkv | blade runner 2049 2017 2160p remux-group | blade runner 2049 @ 2017 | blade runner 2049 @ 2017 | blade runner 2049 @ 2017 |
| 7 | M | `Movies/Blade Runner 2049.mkv` | blade runner 2049 | blade runner 2049 mkv | blade runner 2049 | blade runner @ 2049 | blade runner | blade runner 2049 |
| 8 | M | `Movies/2001 A Space Odyssey.mkv` | 2001 a space odyssey | 2001 a space odyssey mkv | 2001 a space odyssey | 2001 a space odyssey | a space odyssey @ 2001 | 2001 a space odyssey |
| 9 | M | `Movies/1917.mkv` | 1917 | 1917 mkv | 1917 | 1917 | movies @ 1917 | 1917 |
| 10 | M | `Movies/9.mkv` | 9 | 9 mkv | 9 | 9 | 9 | 9 |
| 11 | M | `Movies/8½ (1963).mkv` | 8½ @ 1963 | 8½ (1963) mkv | 8½ | 8½ @ 1963 | 8½ @ 1963 | 8½ @ 1963 |
| 12 | M | `Movies/Once.Upon.a.Time...in.Hollywood.2019.1080p.WEB-DL.mkv` | once upon a time in hollywood @ 2019 | once upon a time in hollywood 2019 1080p web-dl mkv | once upon a time in hollywood 2019 | once upon a time in hollywood @ 2019 | once upon a time in hollywood @ 2019 | once upon a time in hollywood @ 2019 |
| 13 | M | `Movies/WEB.DL.The.Movie (2021).mkv` | web dl the movie @ 2021 | web dl the movie (2021) mkv | web dl the movie | web dl the movie @ 2021 | the movie @ 2021 | web dl the movie @ 2021 |
| 14 | M | `Movies/4K Adventure.mkv` | 4k adventure | 4k adventure mkv | adventure | 4k adventure | adventure | 4k adventure |
| 15 | M | `Movies/Dune.Part.Two.2024.IMAX.2160p.10bit.DV.HDR.WEB-DL.DDP5.1.Atmos.H.265-GRP.mkv` | dune part two @ 2024 | dune part two 2024 imax 2160p 10bit dv hdr web-dl ddp5 1 atmos h 265-grp mkv | dune part two 2024 imax 2160p 10bit dv hdr ddp5 1 atmos h 265-grp | dune part two @ 2024 | dune @ 2024 | dune part two 2024 imax |
| 16 | M | `Movies/A Quiet Place Part II (2020) [2160p] [HDR] [GRP].mkv` | a quiet place part ii @ 2020 | a quiet place part ii (2020) [2160p] [hdr] [grp] mkv | a quiet place part ii (2020) [2160p] [hdr] [grp] | a quiet place part ii @ 2020 | a quiet place @ 2020 | a quiet place part ii @ 2020 |
| 17 | M | `Movies/[YIFY] The Thing (1982) [1080p] [BluRay] [YTS.MX].mp4` | the thing @ 1982 | [yify] the thing (1982) [1080p] [bluray] [yts mx] mp4 | [yify] the thing (1982) [ ] [ ] [yts mx] | the thing @ 1982 | the thing @ 1982 | the thing @ 1982 |
| 18 | M | `Movies/It.(2017).[tmdbid-346364].1080p.mkv` | it @ 2017 | it (2017) [tmdbid-346364] 1080p mkv | it (2017) [tmdbid-346364] | it @ 2017 | it @ 2017 | it @ 2017 |
| 19 | M | `Movies/千と千尋の神隠し (2001) [1080p].mkv` | 千と千尋の神隠し @ 2001 | 千と千尋の神隠し (2001) [1080p] mkv | 千と千尋の神隠し (2001) [ ] | 千と千尋の神隠し @ 2001 | 千と千尋の神隠し @ 2001 | 千と千尋の神隠し @ 2001 |
| 20 | M | `Movies/Se7en [Director's Cut].mkv` | se7en | se7en [director's cut] mkv | se7en [director's cut] | se7en | se7en | se7en |
| 21 | M | `Movies/Heat 1995.mkv` | heat 1995 | heat 1995 mkv | heat 1995 | heat @ 1995 | heat @ 1995 | heat 1995 |
| 22 | M | `Movies/Heat.1995.1080i.HDTV.m2ts` | heat @ 1995 | heat 1995 1080i hdtv m2ts | heat 1995 1080i hdtv m2ts | heat @ 1995 | heat @ 1995 | heat @ 1995 |
| 23 | F | `Movies/The.Matrix.1999.2160p.UHD.BluRay.REMUX-GRP` | the matrix @ 1999 | the matrix 1999 2160p uhd bluray remux-grp | the matrix 1999 2160p remux-grp | the matrix @ 1999 | the matrix @ 1999 | the matrix @ 1999 |
| 24 | F | `Movies/The Godfather Part. 2` | the godfather part 2 | the godfather part 2 | the godfather part 2 | the godfather part | the godfather part 2 | the godfather part 2 |
| 25 | F | `Movies/It (1990) [tmdbid-19614]` | it @ 1990 | it (1990) [tmdbid-19614] | it (1990) [tmdbid-19614] | it @ 1990 | it @ 1990 | it @ 1990 |
| 26 | F | `Movies/The Thing (1982).mkv` | the thing (1982) mkv | the thing (1982) mkv | the thing | the thing @ 1982 | the thing @ 1982 | the thing (1982) mkv |
| 27 | F | `Shows/Dark.2017.S01-S03.COMPLETE.1080p.NF.WEB-DL-GRP` | dark @ 2017 | dark 2017 s01-s03 complete 1080p nf web-dl-grp | dark 2017 s01-s03 complete nf -grp | dark @ 2017 | dark @ 2017 | dark @ 2017 |
| 28 | F | `Shows/[Fansub] 86 - Eighty Six [1080p Batch]` | 86 - eighty six | [fansub] 86 - eighty six [1080p batch] | [fansub] 86 - eighty six [ batch] | 86 - eighty six | shows | 86 - eighty six |
| 29 | E | `Shows/Breaking Bad/Season 1/Breaking.Bad.S01E05.1080p.BluRay.mkv` | 1:5 | 1:5 | 1:5 | 1:5 | 1:5 | 1:5 |
| 30 | E | `Shows/Dark (2017)/Season 2/Dark.2017.S02.E05.1080p.mkv` | 2:5 | 2:5 | 2:5 | 2:5 | 2:5 | 2:5 |
| 31 | E | `Shows/The Wire/Season 3/The Wire Season 3 Episode 9 - Slapstick.mkv` | 3:9 | 3:9 | 3:9 | 3:9 | 3:9 | 3:9 |
| 32 | E | `Shows/The X-Files/Season 4/The.X-Files.4x07.mkv` | 4:7 | — | — | 4:7 | 4:7 | 4:7 |
| 33 | E | `Shows/Dark/Dark S01-S03 COMPLETE/Season 2/Dark (2017) - S02E05 - Lost and Found (1080p NF WEB-DL x265 Ghost).mkv` | 2:5 | 2:5 | 2:5 | 2:5 | 2:5 | 2:5 |
| 34 | E | `Shows/Show/Season 3/01 - Pilot.mkv` | 3:1 | — | — | 3:1 | 3:1 | 3:1 |
| 35 | E | `Shows/Show/Season 3/Episode 12 - Title.mkv` | 3:12 | 3:12 | 3:12 | 3:12 | 3:12 | 3:12 |
| 36 | E | `Shows/Show/Season 3/e05.mkv` | 3:5 | 3:5 | 3:5 | 3:5 | 3:5 | 3:5 |
| 37 | E | `Shows/Show/Season 1/Show.S01E02.2022.1080p.mkv` | 1:2 | 1:2 | 1:2 | 1:2 | 1:2 | 1:2 |
| 38 | E | `Shows/Show/Season 1/Show.S01E20.5.mkv` | 1:20.5 | 1:20.5 | 1:20.5 | 1:20 | 1:20 | 1:20.5 |
| 39 | E | `Shows/Show/Season 1/Show.S01E02-E04.1080p.mkv` | 1:2-4 | 1:2 | 1:2 | 1:2-4 | 1:2-4 | 1:2-4 |
| 40 | E | `Shows/Show/Season 1/Show.S01E02E03.mkv` | 1:2-3 | — | — | 1:2-3 | 1:2-3 | 1:2-3 |
| 41 | E | `Shows/Show/Season 1/Show.S01E02-1080p.mkv` | 1:2 | 1:2 | 1:2 | 1:2 | 1:2 | 1:2 |
| 42 | E | `Shows/Show/Season 1/Show.S01E09 - 3.2.1.mkv` | 1:9 | 1:9 | 1:9 | 1:9 | 1:9 | 1:9 |
| 43 | E | `Shows/Show/Season 1/Show.S01E02 - S02E03.mkv` | conflict | 1:2 | 1:2 | 1:2 | conflict | conflict |
| 44 | E | `Shows/Show/Season 2/Show.S03E04.mkv` | 3:4 | 3:4 | 3:4 | 3:4 | 3:4 | 3:4 |
| 45 | E | `Shows/Show/Season 1/Sample.1080p.mkv` | extra | — | — | — | — | extra |
| 46 | E | `Shows/Show/Season 1/Special (1920x1080).mkv` | — | — | — | — | — | — |
| 47 | E | `Shows/Show/Season 1/Part 2.mkv` | — | — | — | 1:2 | — | — |
| 48 | E | `Shows/Show/Season 1/2024.mkv` | — | — | — | 20:24 | — | — |
| 49 | E | `Shows/Show/Season 1/Show S01E04 [720p].ass` | — | 1:4 | 1:4 | 1:4 | 1:4 | — |
| 50 | E | `Shows/Show/Season 0/Show.S00E01.mkv` | 0:1 | 0:1 | 0:1 | 0:1 | 0:1 | 0:1 |
| 51 | E | `Shows/86/[SubsPlease] 86 - Eighty Six - 05 (1080p).mkv` | ?:5 | ?:5 | ?:5 | ?:5 | ?:5 | ?:5 |
| 52 | E | `Shows/One Piece (1999)/[Fansub] One Piece - 1089v2 [1080p][A1B2C3D4].mkv` | ?:1089 | — | — | ?:1089 | ?:1089 | ?:1089 |
| 53 | E | `Shows/One Piece (1999)/One Piece (1999) 152.mkv` | ?:152 | — | — | 1:52 | ?:152 | ?:152 |
| 54 | E | `Shows/Show/[SubGroup] Show [720p].mkv` | — | — | — | — | — | — |
| 55 | E | `Shows/Asobi Asobase/Asobi Asobase 6.mkv` | ?:6 | — | — | ?:6 | — | ?:6 |
| 56 | E | `Shows/News/News.2024.02.29.720p.HDTV.mkv` | date:2024-02-29 | — | — | date:2024-02-29 | date:2024-02-29 | date:2024-02-29 |
| 57 | E | `Shows/News/News.2023.02.29.720p.HDTV.mkv` | — | — | — | — | ?:2 | — |
| 58 | E | `Shows/Show/Season 2/Show_02x03_1080p.mkv` | 2:3 | — | — | 2:3 | 2:3 | 2:3 |
| 59 | S | `Shows/Dark/Season 02` | 2 | 2 | 2 | 2 | 2 | 2 |
| 60 | S | `Shows/Dark/Dark.S03E01-E14.1080p` | 3 | 3 | 3 | — | 3 | 3 |
| 61 | S | `Shows/Dark/Dark.S01-S03.COMPLETE.1080p` | — | 1 | 1 | 1 | — | — |
| 62 | S | `Shows/Dark/Dark.S01E01-S03E10.1080p` | — | — | — | — | — | — |
| 63 | S | `Shows/Dark/Dark.S02.COMPLETE.1080p` | 2 | 2 | 2 | 2 | 2 | 2 |
| 64 | S | `Shows/Dark/2024` | — | — | — | 2024 | — | — |
| 65 | S | `Shows/Dark/Specials` | 0 | 0 | 0 | 0 | — | 0 |
| 66 | S | `Shows/Dark/The Specials Anthology` | — | 0 | 0 | — | — | — |
| 67 | S | `Shows/Dark/Season_03 [1080p]` | 3 | — | — | 3 | 3 | 3 |
| 68 | M | `Movies/District.9.2009.1080p.BDRip.x265-GRP.mkv` | district 9 @ 2009 | district 9 2009 1080p bdrip x265-grp mkv | district 9 2009 bdrip -grp | district 9 @ 2009 | district 9 @ 2009 | district 9 @ 2009 |
| 69 | M | `Movies/10.Bit.2020.1080p.WEBRip.mkv` | 10 bit @ 2020 | 10 bit 2020 1080p webrip mkv | 10 bit 2020 | 10 bit @ 2020 | movies @ 2020 | 10 bit @ 2020 |
| 70 | M | `Movies/HDR Is the Future (2020).mkv` | hdr is the future @ 2020 | hdr is the future (2020) mkv | hdr is the future | hdr is the future @ 2020 | is the future @ 2020 | hdr is the future @ 2020 |
| 71 | M | `Movies/[REC] (2007) [1080p].mkv` | [rec] @ 2007 | [rec] (2007) [1080p] mkv | [rec] (2007) [ ] | [rec] @ 2007 | movies @ 2007 | (2007) |
| 72 | M | `Movies/Mission.Impossible.III.2006.PROPER.1080p.BluRay-GRP.mkv` | mission impossible iii @ 2006 | mission impossible iii 2006 proper 1080p bluray-grp mkv | mission impossible iii 2006 proper -grp | mission impossible iii @ 2006 | mission impossible iii @ 2006 | mission impossible iii 2006 proper |
| 73 | M | `Movies/The Thing 1982 (1982).mkv` | the thing 1982 @ 1982 | the thing 1982 (1982) mkv | the thing 1982 | the thing 1982 @ 1982 | the thing 1982 @ 1982 | the thing 1982 @ 1982 |
| 74 | M | `Movies/Movie (2020) (Extended Cut) [1080p].mkv` | movie @ 2020 | movie (2020) (extended cut) [1080p] mkv | movie (2020) (extended cut) [ ] | movie @ 2020 | movie @ 2020 | movie (2020) (extended cut) |
| 75 | F | `Shows/24 (2001) [tmdbid-1973]` | 24 @ 2001 | 24 (2001) [tmdbid-1973] | 24 (2001) [tmdbid-1973] | 24 (2001) [tmdbid @ 1973 | 24 @ 2001 | 24 @ 2001 |
| 76 | F | `Shows/Show.Name.2020.1st.Season.1080p.WEB-DL-GRP` | show name @ 2020 | show name 2020 1st season 1080p web-dl-grp | show name 2020 1st season -grp | show name @ 2020 | show name @ 2020 | show name 2020 1st season |
| 77 | E | `Shows/Show/Season 2/ShowS02E09v2.mkv` | 2:9 | — | — | 2:9 | — | 2:9 |
| 78 | E | `Shows/Show/Season 2/Ep_09.mkv` | 2:9 | — | — | — | 2:9 | 2:9 |
| 79 | E | `Shows/Show/Season 2/002.mkv` | 2:2 | — | — | 0:2 | 2:2 | — |
| 80 | E | `Shows/Show/Season 2/Show.S02E05-S02E07.mkv` | 2:5-7 | 2:5 | 2:5 | 2:5 | 2:5-7 | conflict |
| 81 | E | `Shows/Show/Season 2/The Story of S02E05X.mkv` | — | — | — | 2:5 | — | 2:5 |
| 82 | E | `Shows/Show/Season 2/Show.2x03-2x04 [1080p].mkv` | 2:3-4 | — | — | 2:3-4 | 2:3-4 | conflict |
| 83 | E | `Shows/Show/Season 2/Show.2x03.02.mkv` | 2:3 | — | — | 2:3 | 2:3 | 2:3 |
| 84 | E | `Shows/Show/[Team] Show - 02.5v2 [720p].mkv` | ?:2.5 | ?:2.5 | ?:2.5 | ?:2 | ?:2 | ?:2 |
| 85 | S | `Shows/Dark/Dark.S02-S02.COMPLETE` | 2 | 2 | 2 | 2 | 2 | 2 |
| 86 | S | `Shows/Dark/Dark S01 + S02 pack` | — | 1 | 1 | 1 | — | — |
| 87 | S | `Shows/Dark/Specials of the World` | — | 0 | 0 | — | — | — |

</details>
