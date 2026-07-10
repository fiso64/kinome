# Media identity/location/entity plan

## Purpose

Kinome should preserve the user's library identity when files move, while still avoiding accidental merges of distinct versions, editions, or duplicate copies.

The durable model is:

1. `MediaItem`: the logical library node. It owns public item ID, parent relationship, user state, folder settings, tags, virtual tags, added date, and metadata association.
2. `MediaLocation`: one physical filesystem occurrence of a media item. It owns source, relative path, filesystem stats, presence/missing state, hidden/ignored path state, and shadowing.
3. `MediaEntity`: fetched/provider metadata and metadata payload. It can be shared where appropriate, but a shared TMDB match is not proof that two library items are the same `MediaItem`.

The file-tree UI remains the first read model. The storage model should still be neutral enough that future read models can present the same logical items differently without duplicating watch state or metadata.

## Current Status

The schema split mostly exists:

- `media_items` and `media_locations` replaced the legacy path-owned `items` table.
- Existing public item IDs were preserved as `media_items.id`; new child filesystem items use opaque IDs.
- `user_state`, `folder_settings`, `account_visible_items`, item tags, virtual tags, and FTS are keyed to `MediaItem`.
- `media_items_read` provides the legacy-shaped compatibility read model with selected location fields.
- Playback/actions resolve a selected present `MediaLocation` for the exact item being operated on.
- Full-library scans defer cleanup until every source has scanned.
- Conservative move rescue exists for exact source/path, inode/device, same-relative-path across proven-absent sources, and a narrow TV episode reorg case.

The remaining problem is architectural: the scanner still discovers, matches, writes, rescues, and cleans up incrementally. The tables support the right model, but reconciliation is still too close to the old "current path row" design.

## Core Policy

Merge locations into the same `MediaItem` only when they are alternative occurrences of the same library node.

Same `MediaItem` candidates:

- exact existing `source_id + relative_path`;
- unique trustworthy inode/device match;
- prior shadowed location promotion;
- same relative path across sources when an earlier source was successfully scanned and the path is absent;
- strong folder/file/content fingerprint match;
- parsed media identity match with supporting context, such as TV show root plus season/episode set.

Separate `MediaItem` candidates:

- same TMDB movie/show in different logical folders;
- 4K vs 1080p folders;
- director's cut vs theatrical cut;
- backup copy in a non-shadow-equivalent structure;
- title-only or TMDB-only match;
- any ambiguous match where multiple old items or multiple new locations compete.

Ambiguous matches should create separate items or a conflict state. They must not silently merge.

## Internal Refactor Track

These changes should preserve current user-visible behavior. Their job is to make identity decisions explicit and testable before changing policy.

### 1. Add a Scan Reconciliation Layer

Refactor the scan flow into:

```txt
discover physical locations
compute shadowing/source priority inputs
match discovered locations to existing items/locations
build reconciliation plan
apply plan in a transaction
run metadata/search maintenance
```

The first pass can still run sources sequentially and can still use current cleanup defaults. The important internal change is that matching and persistence are no longer interleaved inside filesystem traversal.

Behavior lock tests:

- same-source rename still preserves item ID/state/metadata;
- cross-source same-relative move still preserves item ID/state/metadata;
- in-place TV flat-to-season reorg still preserves episode state;
- cross-source TV copy/delete plus reorg still preserves episode state;
- ambiguous inode/device and same-relative candidates still do not merge.

### 2. Replace `itemId | null` Matching With Decision Objects

Current helpers mostly answer "which item ID should I use?" Replace that with a match result:

```ts
type LocationMatch = {
  itemId: string
  existingLocationId?: string
  rule:
    | 'exact-location'
    | 'inode-device'
    | 'shadow-promotion'
    | 'same-relative-path'
    | 'content-fingerprint'
    | 'parsed-media'
  confidence: 'strong' | 'medium'
  oldSourceId?: string
  oldRelativePath?: string
  reason: string
}
```

This should not change matching decisions yet. It should make tests and logs say why a match happened or why it was declined.

### 3. Move Domain Matching Out of `filesystem.service.ts`

`filesystem.service.ts` should not know TV semantics directly. It should call ordered match rules. TV episode matching becomes one rule among others.

Initial rule order:

1. exact location;
2. unique inode/device;
3. shadow promotion;
4. same-relative-path from a source proven absent this scan;
5. parsed TV episode identity with show-root context;
6. future content fingerprint rules.

### 4. Replace `migrateRecord` With Location-Native Operations

`migrateRecord` is old language. The model should expose operations like:

- attach discovered location to existing item;
- update existing location stats;
- move one existing location to a new source/path;
- mark a vanished location missing;
- update logical item fields that follow the moved node, such as name and parent;
- leave unrelated locations for the same item untouched.

The current implementation updates location rows in a way that can act like "this item has one current path." That should become explicit location reconciliation.

### 5. Make Cleanup Policy Explicit

Keep the current behavior at first, but put it behind a named policy:

```ts
type MissingLocationPolicy = {
  markMissingOnly: boolean
  deleteUnlockedMissingLocationsImmediately: boolean
  deleteLogicalItemWhenNoPresentLocations: boolean
}
```

Once policy is explicit, behavior changes can be made deliberately and tested as product decisions.

### 6. Add Match Diagnostics

Every automatic identity decision should be debuggable:

- matched by exact location;
- matched by inode/device;
- matched by same relative path because source A was scanned and absent;
- declined because two candidates matched;
- declined because parsed identity agreed but fingerprints conflicted.

This can start as structured logs and later become persisted scan diagnostics if needed.

## Behavior Change Track

These changes should be considered user-visible improvements. Each one needs explicit tests and should not be smuggled in as a refactor.

### 1. Preserve Missing Logical Items by Default

Current behavior can delete an unlocked missing location and then delete the logical item if no present locations remain.

Desired behavior: normal rescans should mark locations missing and preserve the logical item for at least a retention/manual-cleanup window. Metadata, watched state, folder settings, tags, images, and `created_at` should survive.

Real usage examples:

- A USB drive or NAS mount is temporarily unavailable.
- A storage-tier job deletes from SSD before the HDD copy is visible to Kinome.
- A user renames a parent folder while Kinome scans a subtree in the middle of the move.

Tests:

- offline source does not delete logical items;
- disappeared movie with user state remains missing, not deleted;
- disappeared show with watched episodes remains missing, not deleted;
- manual cleanup can still permanently remove state when explicitly requested.

### 2. Preserve Multiple Present Locations

Current move rescue often rewrites the item's location to the new source/path. A more complete location model should allow an item to have multiple present locations when they are genuine alternative occurrences.

Real usage examples:

- SSD and HDD both contain the same show during a storage-tier transition.
- A lower-priority shadowed copy exists and should promote when the high-priority copy disappears.
- Source priority changes should switch display/playback location without changing item identity.

Tests:

- same item can have two present locations;
- selected/display location follows source priority;
- removing the preferred location promotes the other location without changing item ID;
- account-visible selected location can differ per account.

### 3. Distinguish Copies From Versions

Same metadata does not imply same item.

Real usage examples:

- `Blade Runner (1982) - Final Cut` and `Blade Runner (1982) - Theatrical Cut`;
- `Movie (2019) 1080p` and `Movie (2019) 4K HDR`;
- a backup copy in a separate non-shadow source;
- two encodes with different cuts, runtimes, or release groups.

Desired behavior: keep separate `MediaItem`s unless a strong move/duplicate policy says they are the same item. They may share a `MediaEntity`, but watch state and item identity remain separate.

Tests:

- same TMDB ID in different edition folders does not merge;
- same title/year with different strong fingerprints does not merge;
- explicitly shadow-equivalent copies can merge as alternate locations.

### 4. Add Strong Fingerprints Beyond TV

The TV reorg fix preserves identity when existing episode metadata plus parsed season/episode numbers provide a strong signal. Movies and generic folders need similar non-inode support.

Real usage examples:

- `SSD/Movies/Arrival (2016)/Arrival.2016.1080p.mkv` becomes `HDD/Movies/Arrival/Arrival.mkv`;
- a movie folder is renamed and copied across drives, losing inode/device;
- a show is reorganized before episode metadata exists.

Candidate fingerprints:

- file size plus stable media hash sample;
- folder child set fingerprint;
- parsed title/year plus file size/runtime when available;
- TV show episode key set and counts;
- existing shadow relationship or historical location relation.

Tests:

- cross-drive movie copy/delete plus rename preserves item ID when fingerprint is unique;
- ambiguous same-size/title movies do not merge;
- show folder copy/delete plus reorg works before and after metadata enrichment.

### 5. Add Conflict Handling

When Kinome cannot safely decide, it should preserve both items or record a conflict rather than guess.

Real usage examples:

- two files both parse as `S01E01`;
- two old items both match the same new file fingerprint;
- a new folder matches an old title but has a different episode set;
- one source has an incomplete copy and another source has a complete copy.

Tests:

- one new location matching multiple old items creates no auto-merge;
- one old item matching multiple new locations creates no auto-merge unless policy allows duplicate locations;
- conflict diagnostics include the declined candidates.

### 6. Make Selected Location Source-Priority and Account-Aware

The compatibility read model currently chooses a selected location from item locations. That choice should eventually use configured source priority and account visibility explicitly.

Real usage examples:

- Admin can see SSD and HDD; a child account can only see HDD.
- A high-priority source is shadowing a lower-priority source for admin, but not for an account that cannot access the high-priority source.
- A user sets a preferred location for an item, but that location is unavailable or hidden for another account.

Tests:

- selected location changes with account visibility;
- inaccessible locations do not shadow accessible locations;
- preferred location is honored only when present and visible.

### 7. Prevent Metadata Refetch on Pure Location Changes

The original reported failure included TMDB refetch and a different TMDB match after a move. Identity preservation should imply metadata stability.

Desired behavior: a pure location move/promotion is not a metadata discovery event. Enrichment should run only when metadata is absent, stale by policy, explicitly refreshed, or the logical item is actually new.

Tests:

- move/promotion with existing `last_refreshed_at` does not call TMDB search/details;
- `created_at` does not change after a move;
- entity link, locked fields, and image paths survive move/promotion.

## Recommended Work Order

### Phase 1: Internal Reconciliation Refactor

Goal: no behavior changes.

1. Add discovery DTOs and reconciliation plan types.
2. Convert existing exact/inode/same-relative/TV matching into rule objects.
3. Return `LocationMatch` decisions with diagnostics.
4. Replace `migrateRecord` call sites with location-native reconciliation operations.
5. Add behavior lock tests around the existing move and ambiguity cases.

### Phase 2: Cleanup and Missing-State Policy

Goal: change deletion behavior deliberately.

1. Add explicit missing-location policy.
2. Change normal scans to preserve missing logical items by default.
3. Add manual or retention-based cleanup path.
4. Add tests for offline, disappeared, and manually forgotten items.

### Phase 3: Multiple Locations and Selection

Goal: make the location model real, not just a move-preservation mechanism.

1. Preserve multiple present locations when policy says they are alternate occurrences.
2. Make selected location use source priority and account visibility.
3. Add UI/API affordances later for "this location" vs "all locations" actions.

### Phase 4: Strong Fingerprints and Conflicts

Goal: improve cross-drive copy/delete+rename matching beyond TV.

1. Add file/folder fingerprints.
2. Use fingerprints in match rules.
3. Add conflict diagnostics for ambiguous matches.
4. Expand movie/show reorg tests.

## Test Matrix

Identity preservation:

- same-source rename;
- same-source reorg;
- cross-source same-relative move;
- cross-source copy/delete plus rename;
- shadowed lower-priority promotion;
- source-priority selected-location change.

State preservation:

- watched state;
- continue watching and next up;
- folder settings;
- account visibility;
- manual tags and virtual tags;
- `created_at`;
- entity link, locked fields, image paths, and `last_refreshed_at`.

Non-merge safety:

- same TMDB ID but different edition folders;
- 4K vs 1080p variants;
- duplicate episode numbers;
- multiple inode/device candidates;
- multiple parsed-media candidates;
- conflicting fingerprints.

Location behavior:

- multiple present locations for one item;
- missing location with another present location;
- missing item with no present locations but preserved state;
- account-specific selected location;
- preferred location unavailable or hidden.

Metadata behavior:

- pure location move does not call TMDB search/details;
- new logical item still enriches normally;
- stale metadata refresh still works by policy;
- manual refresh still bypasses normal gates.

## Design Notes

- `MediaLocation` is not a replacement for playable child file items. A movie folder and its child movie files remain separate `MediaItem`s.
- `parent_item_id` is the native file-tree relationship today, but future relationship tables may be needed for roles such as `alternate_version`, `primary_playable`, `extra`, or `part`.
- `preferred_location_id` is a default preference for an item, not a universal selected location for every account.
- Source/path compatibility fields in public `LibraryItem` output are derived from selected/display location. They are not write authority.
- Automatic matching should be conservative. When in doubt, preserve separate items and state.
