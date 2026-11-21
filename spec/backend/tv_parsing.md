# TV structure parsing

The TV show service assigns seasons and episodes within known shows. It runs during scan enrichment and after identifying a show. The filesystem scanner preserves the physical tree, and source shadowing and move reconciliation use their existing, narrower interpretation of names.

## Seasons

Smart mode recognizes explicit labels such as `Season_02`, `2nd Season`, `S02`, and single-season releases such as `Show.S02E01-E08.2160p`. Two physical folders can claim the same season. A multi-season pack remains a browseable folder. Numeric folders and episode-shaped directories are excluded from Smart's alphabetic fallback.

When there are no explicit season folders and the show has files at its root, ordinary season-relative root files default to season 1. In a mixed show, explicit loose episode coordinates still work, while episode numbers without a season stay unresolved. When a show only has unnumbered season folders, Smart can fall back to natural order. The explicit Alphabetic strategy numbers eligible folders by position.

Known extras such as `Extras`, `OVA`, and `Specials` are skipped for automatic season assignment. A manually assigned season with a locked number can still be processed. Ignored folders stay outside discovery.

## Episodes

Smart mode accepts clear coordinates independently for each video. It combines formats such as `S02E07`, `2x08`, and `Episode 9` in a single folder. Episode-only markers inherit the known season. A locked physical season number takes precedence over the filename during assignment, and locked item fields retain their values. Duplicate claims keep both physical files browseable and leave surrounding episode numbers intact.

Weak numbers need show or sibling context. Bare names such as `002.mkv` need an established season plus independent corroboration. Absolute release numbers need verified season-relative context before assignment. In flat shows, a matching show name and the known first-season episode count establish the first-season range. Smart keeps fractional numbers unless a shared suffix across distinct episodes can be stripped without a collision. Bracketed aspect ratios such as `[4x3]` are ignored as release metadata. Valid combined releases appear under their first episode. Dates and conflicting coordinates remain unassigned.

When a known season contains a plain list with no numbering evidence, Smart can assign by natural order. Known extras stay outside that assignment. Unknown files in partially understood folders stay browseable. Explicit Alphabetic mode uses natural-order positions for videos.

The same parser can recognize coordinates in loose filenames. Automatic show discovery outside known show folders, multiple episode entries per file, and cross-season absolute mapping are outside structural assignment. See the [filename parsing proposal](../../docs/filename-parsing-proposal.md).
