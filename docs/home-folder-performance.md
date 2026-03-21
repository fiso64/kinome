```

Our configuration system is quite flexible, supporting many global and per-folder layout config options, including advanced ones like recursive (container) layouts like tabs and sections. This can already be seen with our new default home folder:

- It is a _virtual_ folder, which automatically pulls items matching a certain set of conditions from the full library. Specifically: parent.retrieve_children_metadata = 1 OR media type = movie OR media type = tv. 
- It is grouped into sections using another virtual tag (_home_category)
- It has some child virtual folders: Recently added (contains items added within the last 14 days, sorted by added date descending), Categories (shows _home_category as buttons), Genres (sources items from home folder and groups them into genre buttons), all of which render inline because home is displayed in section view.

Let's analyze how it performs with the default setup of the home layout on the _second_ load (i.e. after initial groupings have been created). Do it comprehensively, starting with the API requests, going through the explicit DB queries for children fetching and evaluating the specific conditions/vtags we use (home folder definition, _home_category vtag), and returning the data to the consumer. Any performance bottlenecks or things we should be concerned about? Any low (or not low) hanging fruit for optimization? At what scales will our system start to struggle? Discuss.

```

# Home Folder Performance Analysis

## Overview

The home folder is a virtual folder using a sections layout, grouped by `_home_category`. On load, the frontend fires two parallel requests:

1. **`GET /items/home?include=viewHierarchy`** — item details + layout tree
2. **`GET /items/home/children?fields=...`** — the actual content

## What Happens on Load

### Request 1: View Hierarchy

`resolveViewHierarchy` recurses into home's children because `sections` is a container layout. It issues one `parent_id`-indexed query to find child folders (~7: the 4 `_home_category` grouping folders + Categories, Recently Added, Genres), then does a PK lookup per child to resolve their settings. Settings are cached, so this is cheap.

### Request 2: Children

Home has `appliedGrouping: 'vt._home_category'`, so `getGroupedChildren` runs first — a single indexed query returning the virtual grouping folders and user subfolders. Fast.

Then, because the layout is `sections`, `embedChildrenForContainers` runs. It sequentially fetches children for each of the ~7 folders. Five of these are virtual folders whose filters must be compiled and run as full-table scans.

**The expensive part** is that each of those child virtual folders (Movies, TV Shows, Animated Movies, Animated Shows, Recently Added) inherits the home folder's filter via `resolveEffectiveFilter`. Home's filter has 3 OR-groups:

```
[parent.retrieveChildrenMetadata = 1]
OR [mediaType = 'movie']
OR [mediaType = 'tv']
```

`resolveEffectiveFilter` cross-products these with the child's own condition (e.g. `vt._home_category = 'Movies'`), producing 3 OR-groups per child query, each containing a correlated EXISTS subquery. So instead of one simple vtag lookup per child, you get three EXISTS subqueries per row, one of which is a double-join into `items` + `folder_settings`.

**Query count:** ~11 total. Five are filter-based full-table scans.

## Bottlenecks

### 0. No pagination
No pagination.

### 1. Filter cross-product explosion

The home filter's 3 OR-groups propagate into every child filter via `resolveEffectiveFilter`. A child that only needs `vt._home_category = 'Movies'` ends up running 3 OR branches, two of which are redundant given that `_home_category` already implies the item is in the home pool. This is an artifact of how the filter composition works, not a logic bug — but it's expensive.

The `parent.retrieveChildrenMetadata` EXISTS subquery is the worst offender: it joins `items` and `folder_settings` for every candidate row in the first OR branch.

### 2. No single-query path for section data

Each of the 4 `_home_category` grouping sections fires an independent query against the full items table. Since these sections are all subsets of the same home pool, the same rows are being touched repeatedly.

### 3. Scale projections

| Library size | Expected behavior |
|---|---|
| <500 items | Fine. All queries <10ms, total <50ms. |
| 500–2,000 | Good. Queries 10–50ms each, total ~100–300ms. |
| 2,000–10,000 | Noticeable. 50–200ms per scan query, total 500ms–1s. |
| 10,000+ | Problematic. Multi-second load. Serialization cost compounds. |

## Optimization Opportunities

### Materialized home pool via `_is_in_home` vtag (recommended)

The core problem is that home's complex filter (with the `parent.retrieveChildrenMetadata` correlated subquery) re-executes on every read. The fix: move it to the write path.

Introduce `_is_in_home` as a predefined virtual tag.

### Single-query partition for sections

Since all sections are subsets of the same home pool, they could be fetched in a single query and partitioned in memory using the `virtualTags._home_category` value (already included in `CORE_FIELDS` fetches). This eliminates 4 of the 5 expensive queries, replacing them with one pass over the result set in JS.

This is complementary to the vtag approach — with `_is_in_home` in place, the single home-pool query becomes trivially cheap, making the partition approach even more attractive.
