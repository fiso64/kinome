# Metadata canonicalization and vtag ownership

This is separate from the media identity/location refactor.

The identity/location refactor can keep `media_entities` as the existing item-linked
metadata record. This document captures the later metadata/vtag ownership work so
that information does not get lost.

## Goal

Make metadata ownership explicit before `MediaEntity` becomes shared/canonical.

After this refactor:

- `MediaItem` remains the durable logical library item.
- `MediaLocation` remains the physical filesystem presence of an item.
- `MediaEntity` becomes canonical provider identity/facts, such as TMDB movie/show
  details.
- item metadata stores user-visible, item-specific state: locks, selected images,
  user edits, refresh/materialization state, tags, and vtag results.
- filters, grouping, search, and vtag rules continue to operate over assembled
  `LibraryItem` values, not raw storage tables.

## Why This Exists

Today `media_entities` effectively behave as item-specific metadata rows. That
makes entity-bound metadata safe only because most entities are not actually
shared.

Once two logical items share one canonical provider entity, item-specific data on
`media_entities` would leak between them. Examples:

- manual tags;
- virtual tag results;
- locks;
- selected/custom images;
- user-edited metadata;
- item refresh/materialization state that gates enrichment for that specific item;
- season/episode overrides where they are item-specific.

The current item-bound `item_tags` and `item_virtual_tags` work already moved the
most obvious classification leak away from entities. The remaining problem is
that many other user-visible fields still live on `media_entities`.

## Current Code Audit

Reviewed code:

- `src/main/database/schema.ts`
- `src/main/database/repositories/metadata.repo.ts`
- `src/main/database/repositories/filesystem.repo.ts`
- `src/main/database/repo-definitions.ts`
- `src/main/database/query-builder.ts`
- `src/main/database/repositories/search.repo.ts`
- `src/main/database/mappers.ts`
- `src/main/services/metadata.service.ts`
- `src/main/services/metadata-processing.service.ts`
- `src/main/services/item-update.service.ts`
- `src/shared/metadata-fields.ts`
- `src/shared/types.ts`

### Storage Today

`media_items.entity_id` points at `media_entities.id`. The read model exposes the
link as `i.entity_id`, and most metadata joins are still `LEFT JOIN
media_entities e ON i.entity_id = e.id`.

`media_entities` currently mixes all of these concerns:

- provider identity: `tmdb_id`, `media_type`, parent entity relation;
- provider/display data: `title`, `original_title`, `overview`, `release_date`,
  `year`, `tmdb_runtime`, season/episode numbers;
- selected image paths: `poster_path`, `backdrop_path`, `logo_path`;
- item behavior/state: `locked_fields_json`, `last_refreshed_at`, `version`;
- normalized provider facts through `entity_genres` and `credits`.

Genres are user-editable in the current product. The metadata modal binds a
`GenreInput`, `ItemSettingsModal` persists changed `genres`, `METADATA_KEYS`
includes `genres`, and user metadata edits auto-lock changed metadata fields.
The current storage writes those user-edited genres back into `entity_genres`,
which is safe only while entity rows are item-owned.

`ENTITY_SCALAR_METADATA_FIELDS` in `src/shared/metadata-fields.ts` makes that
mixing explicit. It treats `tmdbId`, `title`, images, locks, refresh timestamp,
and version as one write bundle.

Manual tags and virtual tag results now use `item_tags` and `item_virtual_tags`.
The old `entity_tags` and `entity_virtual_tags` tables still exist in schema and
migration code as legacy sources, but current metadata reads and writes use the
item tables.

### Reads Today

`REPOSITORY_SCHEMA` maps public `LibraryItem` fields such as `title`,
`overview`, `posterPath`, `lockedFields`, `lastRefreshedAt`, and `mediaType`
directly to `media_entities` columns.

`ENTITY_COLUMNS_SQL` in `filesystem.repo.ts` selects the same entity columns and
hydrates tags/vtags through item tables.

Search and FTS are still entity-backed for title/overview:

- FTS triggers in `schema.ts` populate `media_items_fts` from `media_entities`.
- `search.repo.ts` rebuilds/searches using `e.title`, `e.overview`, `e.year`,
  `e.poster_path`, etc.

Filtering/grouping can already use item tags and item vtags, but ordinary
metadata fields still mostly resolve through `media_entities`.

### Writes Today

`repositoryService._updateItem` sends every scalar metadata key to
`metadataRepo.upsertMetadata`, which writes to `media_entities`.

`metadataRepo.upsertMetadata`:

- ensures an entity row for the item;
- writes scalar fields to `media_entities`;
- writes genres to `entity_genres`;
- writes credits to `credits`;
- writes manual tags to `item_tags`.

`metadata-processing.service.ts` applies TMDB data by mutating a `LibraryItem`.
It respects `lockedFields`, downloads images into item-id-named files, and then
the update pipeline persists those selected image paths to `media_entities`.

`metadata.service.ts` clear/manual-match/image paths are also item-oriented at
the API level but entity-oriented in storage:

- `clearItemMetadata` resets in-memory item fields, deletes item images, clears
  entity metadata, and clears item tags.
- `applyManualMatch` preserves manual tags, clears metadata, sets `tmdbId` and
  `mediaType`, locks identity fields, then triggers enrichment.
- `setImage` and `removeImage` mutate item image fields, which persist to entity
  image columns.

This is fine while one item owns one metadata row. It is unsafe once entity rows
are canonical/shared.

### TMDB Coupling Today

The current implementation is strongly TMDB-coupled:

- durable columns are named `tmdb_id` and `tmdb_runtime`;
- shared item fields include `tmdbId`, `tmdbRuntime`, `tmdbCredits`,
  `tmdbSeasons`, and `tmdbEpisodes`;
- settings expose one `tmdbApiKey`;
- `retriever.service.ts` is a direct TMDB client;
- `metadata.service.ts` hardcodes TMDB search/details/credits/images flow;
- `metadata-processing.service.ts` expects TMDB payload shapes and image paths;
- API/UI routes and controls are TMDB-specific, such as manual TMDB match and
  TMDB image lookup.

The provider/entity split in this plan is necessary for decoupling from TMDB, but
it is not sufficient on its own. A genuinely provider-decoupled architecture also
needs a provider adapter boundary and generic internal field names.

## What Is Already Correct

- `item_tags` and `item_virtual_tags` exist.
- Existing entity-owned tag rows are migrated by item/entity association.
- Vtag evaluation writes `item_id`.
- Filtering, search, grouping, and vtag maintenance read item tag/vtag tables.
- Genre filtering is currently entity-backed via `entity_genres`, so vtags can
  already be derived from genre. Before entity sharing, this must move to
  effective genres with item-owned overrides.
- Vtag definitions are global library settings today, while vtag results are
  stored as global item facts.

## Target Ownership Model

### Canonical Provider Entity

`MediaEntity` should represent provider identity and fetched provider facts. It
should be safe for multiple library items to point at the same entity.

Canonical/shared:

- provider name, such as `tmdb`;
- provider ID;
- media type;
- parent provider relationship for TV hierarchy;
- canonical fetched title, original title, overview, release date, year, runtime;
- canonical season/episode numbers where they identify provider facts;
- provider genres;
- provider cast/crew/people;
- provider image choices and raw image paths once provider image caching exists;
- raw provider payload/cache fields once provider payload caching exists;
- provider fetch timestamp.

Canonical data may update all linked items, but only through the item-effective
metadata rules below. It must not directly carry item locks, selected images, or
manual classification.

### Provider Boundary

Metadata orchestration should depend on a provider interface, not directly on
TMDB:

```ts
interface MetadataProvider {
  id: string
  search(query: ProviderSearchQuery): Promise<ProviderSearchResult[]>
  getDetails(ref: ProviderRef): Promise<ProviderDetails | null>
  getCredits(ref: ProviderRef): Promise<ProviderCredits | null>
  getImages(ref: ProviderRef, options: ProviderImageOptions): Promise<ProviderImages | null>
  getHierarchy?(ref: ProviderRef): Promise<ProviderHierarchy | null>
}
```

TMDB can be the only initial implementation, but the rest of the metadata service
should talk to a provider registry/adapter. Provider adapters normalize raw
provider payloads into Kinome's canonical provider facts. Provider-specific raw
payloads can still be cached, but they must stay namespaced by `provider`.

Recommended naming direction:

- `tmdbId` -> provider reference, such as `{ provider: 'tmdb', providerId: '603' }`
  or compatibility-backed `providerId`;
- `tmdbRuntime` -> `providerRuntime` or `catalogRuntime`, distinct from ffmpeg
  file duration;
- `tmdbCredits` -> provider/canonical `credits`;
- `tmdbSeasons` and `tmdbEpisodes` -> provider hierarchy cache;
- image source `{ type: 'tmdb' }` -> provider image source with `provider:
  'tmdb'`.

Temporary TMDB-named compatibility fields may remain while the UI/API is migrated,
but they should not be the canonical storage or service boundary after this
refactor.

### Item Metadata

Item metadata should represent the current user-visible metadata state for one
logical item.

Item-specific:

- effective display title/original title/overview where materialized or edited;
- selected/custom image files;
- locks;
- field overrides and explicit clears;
- item refresh/materialization state;
- manual tags;
- virtual tag results;
- item-specific season/episode corrections;
- item metadata version for broadcasts/cache invalidation.

The API can still expose `LibraryItem.title`, `LibraryItem.genres`,
`LibraryItem.posterPath`, etc. The storage layer should assemble those fields
from item metadata plus canonical provider facts.

### Effective LibraryItem Values

The rest of the app should continue to think in terms of assembled
`LibraryItem`s.

For each metadata field, the read model should expose an effective value:

1. item-specific override/materialized value, when present;
2. otherwise canonical provider value, when linked;
3. otherwise filesystem/base item value, where applicable.

This precedence must be centralized in the repository/read model layer. Search,
filtering, grouping, vtag evaluation, autocomplete, detail views, and broadcasts
should not each reinvent a different version of effective metadata.

Important nullable-field detail: the schema must distinguish "no item override,
fall back to canonical" from "the user explicitly cleared this field." A nullable
column alone is not enough for fields where `NULL` is a meaningful user choice.
Use either a per-field override state, an `overridden_fields_json`/`cleared_fields_json`
set, or materialized effective fields with separate provider-refresh rules.

## Vtags With Canonical Metadata

Vtag definitions should remain `LibraryFilter`s over assembled items. That means
rules can still use:

- effective metadata fields like `title`, `year`, `mediaType`;
- effective `genre`, using item genre overrides with canonical provider fallback;
- effective file-derived media facts like `resolutionClass`, `videoHeight`,
  `videoCodec`, `audioChannels`, or `hdrFormat`;
- manual tags;
- parent fields;
- selected-location or filesystem fields.

People/credits are not currently exposed by the general vtag filter editor. They
remain canonical provider facts and can be added as filter fields in a separate
feature.

Vtag results remain item-bound derived facts:

```sql
CREATE TABLE item_virtual_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

The fact being stored is not "TMDB movie 123 has virtual tag quality=4K." It is
"this library item matched the rule and therefore currently has virtual tag
quality=4K."

Because `item_virtual_tags` has no `user_id`, account-dependent vtag results need
different ownership from account-invariant vtag results. A global vtag derived
from `watched` cannot be stored as one `(item_id, key)` row: Alice and Bob can
correctly have different values for the same item and vtag key.

Supported target shape:

- account-invariant vtags remain item-scoped in `item_virtual_tags`;
- account-dependent vtags are either evaluated on read with the current account,
  or stored in an account-scoped result table such as
  `account_item_virtual_tags(account_id, item_id, key, value)`;
- grouping, search, autocomplete, and broadcasts must read the account-scoped
  value when the rule depends on account state.

Genre filtering must continue to work when entities are shared. Because genres
are user-editable, filters and vtags must read effective genres: item genre
overrides first, canonical provider genres as fallback.

## File-Derived Media Facts

One goal of this refactor is to support vtag definitions and search/filter
queries based on extracted file properties, such as `isUltraHD`, `videoHeight`,
`resolutionClass`, `videoCodec`, `hdrFormat`, audio layout, subtitles, bitrate,
or container.

The current direction gets us there only after file-derived facts become
first-class fields in the same assembled-item read/filter layer used by metadata,
tags, and vtags.

### Ownership

Raw ffmpeg extraction belongs to the physical file/location side of the model,
not canonical provider metadata:

- TMDB/runtime/title/genres/credits are provider facts.
- ffmpeg width/height/codec/HDR/audio/subtitle/container facts are file facts.
- different physical locations for the same logical item can have different file
  facts.

Recommended storage shape:

```sql
CREATE TABLE media_location_media_info (
  location_id TEXT PRIMARY KEY REFERENCES media_locations(id) ON DELETE CASCADE,
  location_fingerprint TEXT,
  duration_ms INTEGER,
  container TEXT,
  primary_video_width INTEGER,
  primary_video_height INTEGER,
  resolution_class TEXT,
  primary_video_codec TEXT,
  hdr_format TEXT,
  primary_audio_codec TEXT,
  audio_channels REAL,
  bitrate INTEGER,
  extracted_at INTEGER,
  extraction_error TEXT
);
```

A separate stream table can be added for detailed multi-stream UI later. The
filter/search/vtag layer needs a flattened primary-media projection first.

Folder-backed movie items also need a way to override the auto-selected playable
child:

```sql
-- Exact table/column placement can change, but this relation belongs to the
-- logical item, not to provider metadata.
primary_playable_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL
```

Effective primary playable child:

1. explicit `primary_playable_item_id`, when set;
2. otherwise the largest present, non-hidden, non-ignored supported-video
   descendant by file size;
3. stable tie-breakers such as relative path, name, then item ID.

The auto heuristic should be inspectable and overrideable. It is deliberately a
fallback, not proof that the largest file is always the user's intended edition.

### Effective Item Projection

The app needs item-level effective file fields, because users search for movies
and episodes, not internal storage rows.

Recommended initial rule:

- file items use media facts from their selected present `media_location`;
- that selected location already exists for logical items through
  `media_items.preferred_location_id` plus the `media_items_read.selected_location_id`
  ranking;
- folder-backed movie items do not currently have a canonical playable child;
- folder-backed movie items should expose file facts from a deterministic primary
  playable child;
- explicit primary playable child selection wins;
- without an explicit selection, choose the largest present, non-hidden,
  non-ignored supported-video descendant by file size, with stable tie-breakers
  such as relative path/name/id;
- TV show and season folders do not inherit one child's video resolution as their
  own resolution; episode/file descendants carry the file facts;
- file items with multiple present physical locations use the preferred/selected
  location for effective file facts.

That rule matches the existing `media_items_read` idea: expose one effective
location for file items and let filters operate over assembled items. For
folder-backed movies, the primary playable child can be auto-derived by the
largest-playable-file heuristic and later overridden explicitly. A later "has any
UHD copy" feature can add aggregate fields over all present locations or
descendants, but it should not be confused with the default effective value.

### Query/Vtag/Search Requirements

Add file-derived fields to the same field registry used by filters:

- `REPOSITORY_SCHEMA` entries for fields such as `videoHeight`, `videoWidth`,
  `resolutionClass`, `videoCodec`, `hdrFormat`, `audioChannels`, `container`;
- a read-model/view boundary that exposes those fields from the selected location
  for file items, and from the explicit or auto-derived primary playable child
  for folder-backed movie items;
- `compileFilter`/`buildWhereFragment` support through the normal field path;
- grouping support through `getValuesForKey`;
- autocomplete support for discrete fields such as resolution class, codec, HDR,
  container, and audio layout.

Vtag definitions then work naturally. Example:

```ts
{
  name: 'isUltraHD',
  cases: [
    {
      filter: {
        conditionGroups: [[
          { field: 'videoHeight', op: 'gte', value: 2160 }
        ]]
      },
      result: 'true'
    }
  ],
  defaultResult: 'false'
}
```

Search-bar support has two useful layers:

- vtag search: `>isUltraHD:true` works once the vtag is evaluated and stored in
  `item_virtual_tags` or account-scoped vtag storage;
- direct file-fact search: `>resolutionClass:UltraHD`, `>videoCodec:hevc`, or
  `>hdrFormat:HDR10` require `search.repo.ts` tag filters and
  `SearchInput.svelte` suggestions to understand file-fact keys, not only
  `mediaType`, `year`, `genre`, `person`, manual tags, and vtags.

The current search bar pill syntax is equality-oriented. Numeric comparisons
such as `videoHeight >= 2160` should be represented through `LibraryFilter`-based
configuration, such as vtag definitions, until the search bar gets an operator
syntax.

## Proposed Schema Direction

This is a direction, not final DDL. The exact columns should follow the migration
choices in the product decisions section.

### Canonical Entities

```sql
CREATE TABLE media_entities (
  id TEXT PRIMARY KEY,

  provider TEXT NOT NULL DEFAULT 'tmdb',
  provider_id TEXT,
  media_type TEXT,
  parent_entity_id TEXT REFERENCES media_entities(id) ON DELETE CASCADE,

  canonical_title TEXT,
  canonical_original_title TEXT,
  canonical_overview TEXT,
  canonical_release_date TEXT,
  canonical_year INTEGER,
  canonical_runtime INTEGER,
  canonical_season_number INTEGER,
  canonical_episode_number INTEGER,

  provider_payload_json TEXT,
  provider_images_json TEXT,
  fetched_at INTEGER,
  version INTEGER,

  UNIQUE(provider, provider_id, media_type)
);
```

Notes:

- TV seasons/episodes need an explicit uniqueness decision beyond
  `(provider, provider_id, media_type)`. See product decision 10.
- If we later want multiple providers attached to one canonical work, add an
  `entity_provider_ids` table or a separate provider-ID table. The initial target
  can still use one primary provider identity per canonical entity.
- Current column names can be migrated in place or replaced by new canonical
  names. New names are clearer but require more query churn.
- Keep `media_items.entity_id` as the item -> canonical entity link during this
  refactor. Moving that link into `media_item_metadata` belongs to a separate
  metadata-agnostic-item design, and the link must not live in both places long
  term.

### Item Metadata

```sql
CREATE TABLE media_item_metadata (
  item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,

  title TEXT,
  original_title TEXT,
  overview TEXT,
  release_date TEXT,
  year INTEGER,
  runtime INTEGER,
  media_type TEXT,
  season_number INTEGER,
  episode_number INTEGER,

  poster_path TEXT,
  backdrop_path TEXT,
  logo_path TEXT,

  locked_fields_json TEXT,
  overridden_fields_json TEXT,
  cleared_fields_json TEXT,
  last_refreshed_at INTEGER,
  metadata_version INTEGER NOT NULL DEFAULT 0
);
```

Recommended initial interpretation:

- these columns are the item-effective materialized values, not necessarily
  permanent user overrides;
- `locked_fields_json` prevents provider refresh from changing selected fields;
- `overridden_fields_json` marks fields explicitly edited by the user;
- `cleared_fields_json` marks fields explicitly cleared so canonical fallback
  does not silently reappear;
- `last_refreshed_at` tracks this item being matched/materialized, while
  `media_entities.fetched_at` tracks the provider payload freshness.

### Genres

```sql
CREATE TABLE entity_genres (
  entity_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, genre_id)
);
```

`entity_genres` stores canonical provider genres. User-edited item genres need
item-owned override storage:

```sql
CREATE TABLE item_genres (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, genre_id)
);
```

An equivalent item override representation is acceptable, but it must be
item-owned. The filter layer needs one canonical "effective genres" SQL
expression/subquery, and `genre`/`genres` filters, grouping, autocomplete, search,
and vtags must use it.

### Tags And Vtags

Manual/user tags and vtag results are already in the correct ownership shape:

```sql
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

```sql
CREATE TABLE item_virtual_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

The remaining cleanup is to remove old entity tag tables once all migration
paths and tests no longer need them.

## Implementation Plan

### Phase 0: Lock The Intended Behavior In Tests

Before moving storage, add tests that describe the target behavior. For a strict
red/green migration, add the tests first as expected failures or skipped tests.

Cover:

- two items linked to the same provider identity can have different manual tags;
- two items linked to the same provider identity can have different vtags;
- two items linked to the same provider identity can have different selected
  posters/logos/backdrops;
- one item's locked title/overview/image does not block provider refresh for the
  canonical entity or other linked items;
- clearing metadata for one item does not clear canonical provider facts or
  another item's metadata;
- search and FTS use effective item title/overview;
- filters and grouping use effective values, including item tags/vtags;
- genre filters use item genre overrides with canonical fallback;
- manual match preserves user-owned fields and relinks provider identity without
  leaking item state.

### Phase 1: Add Item Metadata Storage Without Sharing Entities Yet

Add `media_item_metadata` and backfill one row per existing item that currently
has an entity.

Backfill from current `media_entities`:

- scalar display fields;
- selected image paths;
- locked fields;
- `last_refreshed_at`;
- version.

Do not deduplicate entities in this phase. Preserve the existing one-item-ish
entity model so the read/write migration can be verified without introducing
provider sharing at the same time.

Migration requirements:

- preserve every existing visible `LibraryItem` field after migration;
- preserve `media_items.entity_id` links;
- preserve `item_tags` and `item_virtual_tags`;
- preserve `entity_genres` and `credits`;
- tolerate legacy DBs with old `entity_tags` and `entity_virtual_tags`;
- for a legacy DB that already has multiple items pointing at one entity,
  duplicate item metadata rows because those current effective values cannot be
  safely inferred per item otherwise.

### Phase 2: Centralize Effective Metadata Reads

Introduce one SQL/read-model boundary for effective metadata.

Options:

- expand `media_items_read` to join item metadata and expose effective metadata
  columns;
- create a separate `media_items_effective_metadata` view and join it from
  repository queries;
- keep a generated SQL fragment, similar to `ENTITY_COLUMNS_SQL`, but make it
  the only public route for metadata columns.

Whichever option we pick, update:

- `REPOSITORY_SCHEMA`;
- `ENTITY_COLUMNS_SQL` or its replacement;
- `mapRowToLibraryItem` metadata presence logic;
- `query-builder` field joins and parent-field conditions;
- `search.repo.ts` select/filter/order expressions;
- FTS rebuild SQL;
- FTS triggers in `schema.ts` and migrations;
- autocomplete/grouping helpers that depend on metadata fields;
- file-derived media fact fields so vtags and search can use ffmpeg-extracted
  properties through the same filter path.

Target: callers still request `title`, `posterPath`, `mediaType`, `genres`, etc.,
but those names now mean effective item values.

### Phase 3: Add File-Derived Media Fact Layer

Add the ffmpeg-derived file fact storage and expose it through the same effective
item read/filter boundary.

Work:

- create `media_location_media_info` or equivalent location-owned media-info
  storage;
- extract facts per physical location and record the location fingerprint used
  for extraction;
- mark media-info rows stale when a location fingerprint changes;
- expose effective item fields such as `videoHeight`, `videoWidth`,
  `resolutionClass`, `videoCodec`, `hdrFormat`, and `audioChannels`;
- centralize the supported-video-file classifier currently represented by
  `isSupportedVideoFile`;
- add explicit primary playable child support for folder-backed movies;
- auto-derive the primary playable child from the largest present, non-hidden,
  non-ignored supported-video descendant when no explicit primary child is set;
- add `REPOSITORY_SCHEMA`, `compileFilter`, grouping, autocomplete, and search
  support for the new fields;
- verify that vtag evaluation can derive `isUltraHD` from `videoHeight >= 2160`;
- verify that search can find high-resolution media by vtag
  (`>isUltraHD:true`) and direct file-fact pill (`>resolutionClass:UltraHD`).

### Phase 4: Split Metadata Writes By Ownership

Refactor `metadataRepo.upsertMetadata` into explicit operations:

- provider/canonical entity writes;
- item-effective metadata writes;
- item tag writes;
- provider genre/credit writes;
- item genre override writes.

Update `repositoryService._updateItem` so scalar metadata keys no longer all go
to `media_entities`. Suggested split:

- user edits, selected images, locks, explicit clears, refresh/materialization
  state -> `media_item_metadata`;
- TMDB/provider identity and provider facts -> `media_entities`;
- provider genres from TMDB -> `entity_genres`;
- user genre edits -> item-owned genre overrides/effective genre storage;
- credits -> canonical provider facts;
- manual tags -> `item_tags`;
- vtag results -> `item_virtual_tags`.

The in-memory `LibraryItem` mutation style can remain temporarily, but the final
persistence boundary should know the origin of each metadata change: provider
refresh, user edit, clear, manual match, or derived vtag evaluation. Retaining the
generic `updateIfChangedAndBroadcast` path requires passing write intent through
that path.

### Phase 5: Update Metadata Operations

Update the service-level behaviors to respect the split.

Provider enrichment:

- search/match item to a provider entity;
- fetch/update canonical entity facts;
- materialize effective item metadata for unlocked/non-overridden fields;
- update item `last_refreshed_at`;
- recalculate item vtags for affected items;
- broadcast affected item-effective values.

Manual match:

- preserve item-owned fields such as tags, selected images, user overrides, and
  locks according to the product decision below;
- relink `media_items.entity_id` to the matched provider entity;
- clear stale provider-derived item fields that should be rematerialized;
- continue the current identity-lock behavior (`tmdbId`, plus `seasonNumber` for
  season matches) and document it as product behavior;
- enrich the item and scoped TV descendants.

Clear metadata:

- clear only the target item's item metadata/tags/overrides according to the
  product decision below;
- unlink or keep provider identity according to the clear mode;
- delete shared canonical provider facts only after an orphan cleanup proves no
  items reference the entity;
- delete selected custom image files only for the cleared item.

Images:

- selected image paths live on `media_item_metadata`;
- current item-id-named asset files can remain item-specific;
- future provider image lists/cache live on canonical entities or a provider image
  table.

TV structure:

- canonicalize show/season/episode provider facts after the TV identity key is
  explicit;
- local item-specific season/episode corrections should live in item metadata;
- ephemeral `tmdbSeasons`/`tmdbEpisodes` caches remain transient until a separate
  persisted provider-cache feature exists.

### Phase 6: Enable Canonical Entity Sharing

Only after item metadata reads/writes are split, change entity creation/matching.

`ensureEntityForItem` should stop meaning "make an item-owned metadata row."
Instead:

- for known provider results, `getOrCreateEntity(provider, providerId, mediaType,
  hierarchyKey)` returns a canonical entity;
- the item links to that entity;
- provider facts are refreshed on the entity;
- item metadata is materialized independently.

Deduplication migration:

- group existing entities by provider identity;
- pick or create one canonical entity per group;
- merge provider facts conservatively;
- relink items to the canonical entity;
- keep each item's `media_item_metadata` row intact;
- preserve all item tags/vtags/locks/images/overrides;
- do not merge entities without an unambiguous provider identity.

### Phase 7: Cleanup Legacy Entity-Owned Classification

After all read/write paths use item tables:

- remove `entity_tags`;
- remove `entity_virtual_tags`;
- remove unused indexes and migration compatibility shims when safe;
- update old tests that still seed entity tag rows, except dedicated migration
  tests;
- add a migration test that verifies legacy entity tags/vtags still migrate into
  item tables before the old tables are dropped or ignored.

### Phase 8: Optional Hardening

These are useful but not required to make canonical entity sharing correct:

- provider image cache/deduplication;
- stale provider fetch scheduling independent from item materialization;
- richer conflict UI for multiple local items sharing one provider entity;
- background orphan cleanup for unreferenced canonical entities;
- richer provenance/audit fields for user edits vs provider refreshes.

## Required Tests

Migration tests:

- old DB with one item/entity preserves every scalar metadata field;
- old DB with multiple items sharing one entity gives each item its own
  item-metadata row with the same previous effective values;
- old `entity_tags` and `entity_virtual_tags` migrate to item tables;
- image paths, locks, `last_refreshed_at`, version, genres, and credits survive;
- legacy `tmdb_id` values migrate to provider identity rows/columns with
  `provider = 'tmdb'`;
- migration is idempotent.

Repository/read tests:

- `getItemById` returns effective item metadata over canonical fallback;
- `find` filters on effective metadata;
- parent-prefixed filters use parent effective metadata;
- sorting by title/year/media type uses effective metadata;
- item tags and vtags do not require an entity link;
- genre filters use item genre overrides with canonical fallback.

Search tests:

- FTS rebuild indexes effective title/original title/overview;
- FTS triggers update when item metadata changes;
- FTS triggers update linked items when canonical title/overview changes and no
  item override masks it;
- search tag filters still use item tags/vtags and provider people/genres.
- search tag filters can match file-derived facts such as `resolutionClass` and
  `videoCodec`;
- searching by `>isUltraHD:true` returns matching logical movie/file items once
  the vtag is derived from extracted file facts.

Metadata service tests:

- metadata enrichment can run against a fake provider adapter without importing
  or mocking TMDB-specific retriever code;
- provider refresh updates canonical entity and only unlocked item fields;
- one item's lock does not affect another item sharing the entity;
- selected image set/remove affects one item only;
- clear metadata affects one item only;
- manual match preserves the decided item-owned fields;
- credits remain shared provider facts;
- vtags are recalculated for affected items after item metadata changes.

TV tests:

- show, season, and episode materialization preserves item-specific overrides;
- season/episode number locks or corrections do not leak to sibling items;
- manual season match does not rewrite unrelated seasons/items through a shared
  entity.

File-fact tests:

- ffmpeg extraction writes media facts per physical location;
- changing a location fingerprint marks media facts stale and re-extracts them;
- file items expose selected-location media facts as effective fields;
- folder-backed movie items with one playable child can expose that child's media
  facts;
- folder-backed movie items with multiple playable children choose the largest
  present, non-hidden, non-ignored supported-video descendant as the auto-primary
  child;
- largest-playable-child ties resolve deterministically;
- explicit primary playable child selection overrides the heuristic;
- TV show/season folders do not incorrectly inherit one episode's resolution;
- vtag evaluation can derive `isUltraHD` from `videoHeight >= 2160`;
- search-bar `>resolutionClass:UltraHD` and `>isUltraHD:true` return the expected
  logical items.

## Product Decisions For Discussion

These should be decided deliberately. They are not just implementation details.

1. Do we want canonical shared `MediaEntity` at all?

   Recommendation: yes, but only after item metadata storage exists. Shared
   provider facts make duplicate copies, merged locations, search, and future
   provider refreshes cleaner. The cost is needing a real item-effective metadata
   layer.

2. Should item metadata be materialized effective values or sparse overrides?

   Materialized values preserve current UI exactly and are easier to query. Sparse
   overrides are cleaner conceptually but need careful null/clear semantics.

   Recommendation: materialize effective item metadata initially, plus
   `overridden_fields_json` and `cleared_fields_json` so we can distinguish user
   choices from provider-derived values.

3. Where should the item -> canonical entity link live?

   It currently lives on `media_items.entity_id`.

   Recommendation: keep it there during this refactor and redefine it as the
   canonical provider link. Moving it into `media_item_metadata` belongs to a
   separate metadata-agnostic-item design.

4. What should "Clear metadata" mean?

   Possible meanings:

   - clear only item overrides/materialized metadata;
   - also unlink the provider entity;
   - also delete selected/custom images;
   - also clear manual tags;
   - also clear locks.

   Recommendation: separate at least two operations in product language:
   "clear metadata" clears item metadata/selected images/locks, while "unmatch"
   unlinks provider identity. Manual tags should remain preserved; clearing tags
   should be an explicit tag operation.

5. Which fields are user-editable and therefore item-specific?

   Title, overview, images, locks, tags, manual match identity, and genres are
   user-editable item-specific state. Current code proves this for genres through
   the metadata editor, `METADATA_KEYS`, auto-locking on user edits, and
   `metadataRepo.upsertMetadata` accepting `updates.genres`.

   Recommendation: add item-owned genre overrides and make filters, grouping,
   search, autocomplete, and vtags use effective genres.

6. What is the effective genre precedence?

   Canonical provider genres should remain useful as fetched provider facts, but
   user-edited genres must be able to classify two copies of the same movie
   differently.

   Recommendation: use canonical genres as fallback and item genre overrides when
   present. That keeps TMDB-derived filtering simple while preserving local
   corrections.

7. What is the refresh model?

   `media_entities.fetched_at` answers "is the provider payload fresh?"
   `media_item_metadata.last_refreshed_at` answers "has this item been matched
   and materialized?"

   Recommendation: keep both. A fresh provider entity can avoid refetching TMDB,
   but each item still needs its own materialization/lock/vtag pass.

8. What should manual match preserve?

   Current code preserves manual tags, clears metadata, locks `tmdbId`, and
   refreshes in the background. With item metadata, the real product decision is
   which item-owned fields survive rematching: custom selected images, locked
   fields, user edits, or only manual tags.

   Recommendation: preserve manual tags and custom images by default; preserve
   locked user edits by default; provide an explicit replace option; clear
   provider-derived unlocked fields for rematerialization.

9. Should selected images be deduplicated?

   Current image files are item-id-named, so selected images are item-specific.
   Provider image lists are a separate canonical-cache feature.

   Recommendation: keep selected image files item-specific in this refactor.
   Defer provider image cache/deduplication.

10. How should TV provider identity be keyed?

    Movies and shows can use TMDB ID plus media type. Seasons and episodes may
    need parent show identity plus season/episode number, or a stable
    provider-specific season/episode ID.

    Recommendation: do not dedupe season/episode entities until the key is
    explicit and tested. Use show provider ID plus season/episode numbers as the
    conservative starting point until a suitable stable provider ID exists for
    every level.

11. Should vtag defaults apply to items without metadata?

    Current vtag evaluation writes item-bound results and can evaluate rules over
    non-entity fields. A proposed checkbox was "apply only to items with
    metadata/entity."

    Recommendation: keep vtags item-based by default and do not require metadata.
    Rules that reference metadata naturally only match when metadata is present.
    Add a rule/config switch only for the product behavior "suppress default vtags
    on unmatched filesystem items."

12. How should explicit field clearing work?

    A user-cleared overview with a canonical fallback raises a product question:
    should the overview stay blank or fall back to TMDB?

    Recommendation: explicit clears should remain blank until refresh/reset. That
    means we need `cleared_fields_json` or equivalent state.

13. What happens when provider facts conflict during dedupe?

    Two legacy entities with the same TMDB ID can have different titles/images
    because old user edits lived on entity rows. Those differences likely belong
    to item metadata, not the canonical entity.

    Recommendation: during dedupe, preserve each item's old effective values in
    item metadata. Prefer canonical facts from a fresh provider fetch; otherwise
    choose one entity's provider facts deterministically and never discard
    item-effective values.

14. Can vtag rules depend on user/account state?

    Yes, but then the evaluated vtag value is account-specific. The current
    `item_virtual_tags` table is global per item and cannot represent both
    Alice's and Bob's value for the same `(item_id, key)`.

    Recommendation: support both ownership modes. Account-invariant vtags stay in
    `item_virtual_tags`. Account-dependent vtags use account-scoped evaluation or
    an account-scoped result table, and the read paths for grouping, search,
    autocomplete, and broadcasts must pass account context.

15. What does an item-level file property mean?

    File properties are extracted from physical files, but filters and search
    operate on logical items. A movie can be a single file, a folder-backed movie,
    or an item with multiple present locations.

    Current code already has selected physical locations for a logical item:
    `media_items.preferred_location_id` and the selected-location ranking in
    `media_items_read`. That solves "which physical copy of this file item is the
    effective one." It does not solve "which child file is the main playable file
    for this movie folder."

    Recommendation: file items use the selected physical location. Folder-backed
    movies expose file facts from a primary playable child. An explicit primary
    child selection wins; otherwise auto-select the largest present, non-hidden,
    non-ignored supported-video descendant by file size, with stable tie-breakers.
    This is predictable for search and works for ordinary movie folders with
    extras, where the main feature is usually the largest file. Add aggregate
    fields later for questions such as "has any UHD copy" or "all locations are
    UHD."

16. How should high-resolution search work in the search bar?

    Users should be able to search for high-resolution media directly from the
    search bar.

    Recommendation: support both named vtags and direct discrete file-fact pills:
    `>isUltraHD:true` for a vtag and `>resolutionClass:UltraHD` for the extracted
    file fact. Keep numeric comparison syntax out of the search bar initially;
    represent `videoHeight >= 2160` through `LibraryFilter`-based configuration,
    such as vtag definitions.

17. How provider-agnostic should this refactor be?

    Current code is TMDB-specific. The target storage model uses `provider` and
    `provider_id`, but that alone does not decouple metadata enrichment,
    matching, image selection, TV hierarchy, or public item fields from TMDB.

    Recommendation: make the storage and service boundary provider-agnostic in
    this refactor, while keeping TMDB as the only implemented provider. Add a
    provider adapter interface, migrate TMDB-specific storage to `provider =
    'tmdb'`, normalize provider payloads before they enter canonical entities,
    and keep TMDB-named API/UI fields only as temporary compatibility aliases.
    Multi-provider matching and cross-provider entity merging can wait.

## Non-Goals

- This is not a precondition for media identity/location splitting.
- This does not require provider image deduplication.
- This does not require a conflict-management UI in the first implementation.
- This should not change the public `LibraryItem` shape without a deliberate
  product/API change.
- This should not make vtags entity-owned again. Vtag definitions operate over
  assembled items; vtag results belong to items.
