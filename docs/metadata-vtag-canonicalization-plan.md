# Metadata canonicalization and item-bound tags/vtags

This is separate from the media identity/location refactor.

The identity/location refactor can keep `media_entities` as the existing item-linked metadata record. This document captures the later metadata/vtag ownership work so that information does not get lost.

## Problem

Today `media_entities` effectively behave as item-specific metadata rows. That makes entity-bound `entity_virtual_tags` mostly behave like item tags by accident.

If `MediaEntity` ever becomes canonical/shared provider data, user/library classification must move off the entity or it will leak between distinct items that share the same TMDB identity.

Examples of data that must not leak between two logical items:

- manual tags;
- virtual tag results;
- locks;
- selected/custom images;
- user-edited metadata;
- item refresh state if it gates enrichment for that specific item;
- season/episode overrides where they are item-specific.

## Desired Semantics

Canonical `MediaEntity`:

- provider IDs;
- canonical fetched title, overview, release fields;
- provider genres, cast, crew, studios, ratings;
- raw provider payload and fetched timestamp;
- deduplicated provider image cache, if we add one later.

Item-specific metadata:

- title/metadata overrides;
- locks;
- selected/custom images;
- manual tags;
- virtual tag results;
- item refresh state;
- item-specific season/episode corrections.

Vtag definitions stay as `LibraryFilter`s over assembled items, so rules can still use fields like `genre`, `mediaType`, watched state, parent fields, or selected-location fields. Vtag results are item-bound derived facts: the item matched the rule, so the computed `{ key, value }` belongs to that item.

Genre filtering still reads metadata/entity genre tables. Item-bound vtag output does not mean every input field must live on the item row.

## Possible Schema Direction

Canonical entity table:

```sql
CREATE TABLE media_entities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  media_type TEXT,
  canonical_title TEXT,
  canonical_payload_json TEXT,
  fetched_at INTEGER,
  UNIQUE(provider, provider_id, media_type)
);
```

Item-specific metadata table:

```sql
CREATE TABLE media_item_metadata (
  item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES media_entities(id) ON DELETE SET NULL,

  title TEXT,
  original_title TEXT,
  sort_title TEXT,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  logo_path TEXT,
  runtime INTEGER,
  release_date TEXT,
  year INTEGER,
  rating REAL,
  media_type TEXT,
  season_number INTEGER,
  episode_number INTEGER,
  locked_fields_json TEXT,
  last_refreshed_at INTEGER,
  metadata_version INTEGER NOT NULL DEFAULT 0
);
```

Item-bound virtual tags:

```sql
CREATE TABLE item_virtual_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

Manual/user tags should follow the same ownership rule:

```sql
CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (item_id, key)
);
```

## Work Already Done

- `item_tags` and `item_virtual_tags` exist.
- Existing entity-owned tag rows are migrated by item/entity association.
- Vtag evaluation writes `item_id`.
- Filtering, search, autocomplete, grouping, and vtag maintenance read the item tag tables.
- Genre filtering remains entity-backed via `entity_genres`, so vtags can still be derived from genre.

## Remaining Work

- Decide whether to canonicalize `media_entities` at all.
- If yes, add an item-specific metadata/override table before allowing multiple items to share a canonical entity.
- Move locks, selected images, user edits, refresh gates, and item-specific overrides to the item metadata table.
- Decide whether canonical provider images should be cached separately from selected/custom item images.
- Update metadata reads with clear precedence rules, such as item override first, then canonical provider value.
- Update metadata writes so user edits go to item metadata and provider refreshes update canonical entity data.
- Add a vtag config option such as "apply only to items with metadata/entity" if needed; this was previously suggested as a checkbox enabled by default.
- Drop any remaining unconditional `i.entity_id IS NOT NULL` assumptions in vtag evaluation unless guarded by that config.
- Add regression tests that two items sharing one canonical entity can have different vtags, manual tags, locks, images, and user edits.

## Non-Goals For Identity/Location Refactor

Metadata canonicalization is not a precondition for splitting durable `MediaItem` identity from physical `MediaLocation`s. The identity/location refactor should preserve the existing item/entity relationship and keep item-bound tag tables as already implemented.
