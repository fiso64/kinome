# Spec: API Redesign v2 ("Lean & Lazy")

**Version:** 2.1
**Status:** Proposed

---

## 1. Abstract

This specification proposes a complete restructuring of the Client-Server API contract. It moves away from the current architecture—where the frontend receives and manages a massive, nested "Root" object containing the entire database—to a "Lean & Lazy" model. In this new model, the frontend requests specific items by ID on demand. Lists utilize lightweight data structures, while full metadata is reserved for detail views. Logic for sorting, grouping, structure parsing, and playback queue generation is moved strictly to the backend.

## 2. Problem Statement / Motivation

The current "Electron-legacy" architecture creates significant bottlenecks now that the application operates as a Server/Web Client model.

- **Performance:** Loading the application requires serializing and transferring the entire library structure. For large libraries (e.g., 5,000+ items), this payload is massive, causing slow initial loads and high memory usage in the browser.
- **Synchronization Bugs:** Logic for interpreting file structures (specifically parsing `S01E01` filenames and assigning numbers) currently happens reactively on the frontend. This leads to race conditions where the view renders before the logic runs, resulting in unnumbered episodes and broken sorting.
- **Scalability:** Client-side grouping (e.g., "Group by Genre") requires the client to iterate over thousands of items in memory. This freezes the UI on lower-powered devices.

- **User Story:** As a user with a large library, I want to navigate into a "Season" folder and immediately see episodes sorted by number, without waiting for the UI to "figure out" the order.
- **User Story:** As a user, I want the home screen to load instantly, regardless of whether I have 100 or 100,000 items.

## 3. Goals and Non-Goals

### Goals

- **Strict Separation of Concerns:** The Backend is the source of truth for structure, sorting, and grouping. The Frontend is purely a presentation layer.
- **Minimize Payload Size:** List views must fetch only the bare minimum data required to render a "Card" (ID, Title, Poster, Type).
- **Fix TV Structure Logic:** Move season/episode number assignment to the ingestion phase (Scanner) so the API always returns sorted, valid data.
- **Robust Playback Context:** Ensure "Autoplay Next Episode" works reliably via server-side queue generation, independent of what the client currently has loaded in memory.
- **Seamless Navigation:** Maintain scroll position and view state accurately, despite the asynchronous nature of data fetching.

### Non-Goals

- **Offline Support:** This spec assumes a connected state; we are not architecting for offline caching of the entire database.
- **GraphQL:** We will stick to REST-like endpoints rather than introducing a new query language stack.

#### Deferred Scope (Known Deficiencies)

This proposal strictly addresses data retrieval and structure (Read operations). It deliberately ignores known deficiencies regarding "Client-Side File Picking" (uploading artwork/subtitles) and "Server Path Browsing" (selecting library roots on headless servers). These features require dedicated system-level endpoints (e.g., `POST /upload`, `GET /system/browse`) which will be specified in a subsequent RFC.

## 4. Proposed Solution & Technical Design

The core change is moving from a Tree-Traversal model to an **ID-Based Navigation** model.

### Data Contracts

We will adopt a **Unified Interface** strategy (similar to Jellyfin's `BaseItemDto`). Instead of maintaining rigid `ListingItem` vs. `DetailItem` types, we use a single `LibraryItem` interface where most fields are optional.

**The Rule:**

1.  **Core Fields:** Always populated by the backend.
2.  **Expansion Fields:** _Omitted_ from the json unless explicitly requested via the `?include=` query parameter.

```typescript
interface LibraryItem {
  // --- Core (Always Returned) ---
  id: string
  name: string // Filesystem name or simple name
  type: 'file' | 'folder'
  mediaType?: 'movie' | 'tv' | 'season' | 'episode'
  posterPath?: string // Relative URL
  watched?: boolean // For UI greying/badges
  isMissing?: boolean // Visual warning
  year?: number
  seasonNumber?: number
  episodeNumber?: number

  // --- Expansion Fields (Lazy - Requires ?include=) ---
  overview?: string // Heavy text blob
  path?: string // Full server path (security/size)
  backdropPath?: string
  logoPath?: string
  genres?: string[]
  tags?: Record<string, string>

  // --- Rich Data (Heavy - Requires ?include=) ---
  people?: {
    cast: Person[]
    crew: Person[]
  }

  // --- Settings (Contextual) ---
  viewSettings?: StoredViewSettings
  scraperSettings?: ScraperSettings
}
```

### Public API Changes

All endpoints will be polymorphic (handling Movies, Folders, Seasons, etc. uniformly via ID).

#### 1. `GET /api/v2/items/:id`

- **Returns:** `LibraryItem`
- **Query Parameters:**
  - `include`: A comma-separated list of extra fields to populate (e.g., `overview,people,path`).
- **Purpose:** Fetches data for a specific entity.
  - **Default Behavior:** Returns **only Core Fields** (same as List View). To get the full details for a Detail View, the client must explicitly request them (e.g., `?include=overview,people,genres`).
- **Virtual Support:** If `:id` indicates a virtual folder (e.g., `virtual:genre:Action`), the backend constructs a synthetic `LibraryItem` on the fly.

#### 2. `GET /api/v2/items/:id/children`

- **Returns:** `{ items: LibraryItem[], total: number }`
- **Query Parameters:**
  - `limit`, `offset`: For pagination (Infinite Scroll).
  - `groupBy`: Control the data transformation layer.
    - `auto` (Default): The backend resolves the item's view settings. If the layout is `sections` or `tabs`, it performs grouping automatically.
    - `none`: Forces a flat list of children, ignoring any grouping settings. Used for simple pickers or list views.
    - `[key]`: (e.g., `genre`). Forces grouping by a specific key, overriding persistent settings.
  - `filter`: A string for contextual filtering (e.g., "Matrix").
  - `includeHidden`: boolean. If true, returns items marked `isHidden=1`. Required for Folder Settings management.
  - `include`: A comma-separated list of extra fields to populate in the returned items.
    - **Default Behavior:** If `include` is empty, returns **only Core Fields**.
    - **Grid View:** Requests default (minimal payload).
    - **List View:** Requests `?include=overview,genres`.
- **Backend Logic:**
  - **Settings Resolution:** The backend uses the centralized `resolveViewSettings` logic to determine the active `layout` and `groupBy` key for the requested ID.
  - **State Normalization:** If the resolved `layout` is not `sections` or `tabs`, any `groupBy` setting is ignored (treated as `none`).
  - **Recursive Transformation:** If grouping is active, the backend performs the transformation and returns items with `type: 'folder'` (Virtual Folders).
  - **Deep Grouping (Lookahead):** To avoid the "network waterfall", the backend recursively applies grouping to the children of the newly created virtual folders if they also have a grouping policy (e.g. Root > Group By Genre > Child Groups by Year).
  - **TV Specifics:**
    - If the ID belongs to a **Season**, the SQL query automatically includes `ORDER BY episode_number ASC`.
    - If the ID belongs to a **TV Show**, the SQL query sorts by `season_number ASC`.

#### 3. `GET /api/v2/autocomplete` (New)

- **Returns:** `{ suggestions: string[] }`
- **Query Parameters:**
  - `type`: The type of data to autocomplete (e.g., `genre`, `tag`, `person`).
  - `query`: The partial string typed by the user.
- **Purpose:** Replaces the client-side calculation of suggestions. The backend uses efficient `DISTINCT` queries or FTS indices to return relevant suggestions without loading the entire DB.

#### 4. `POST /api/v2/queues`

- **Purpose:** Generates a playlist of IDs starting from a specific item, respecting the context (e.g., playing an episode should queue the rest of the season, then jump to the next season).
- **Request Body:**
  ```typescript
  {
    startItemId: string;
    contextType: 'folder' | 'search' | 'collection';
    contextId: string; // The ID of the folder/collection we are playing from
    filter?: string;   // Apply current UI filter if applicable
  }
  ```
- **Returns:** `{ queue: string[] }` (An ordered list of Item IDs).
- **Why Server-Side?** Logic like "Jump from S01E10 to S02E01" requires knowledge of the file structure that the client may not have loaded (due to pagination). The server acts as the source of truth for "Next Up".

#### 4. `GET /api/v2/items/:id/ancestors`

- **Returns:** `ListingItem[]`
- **Purpose:** Breadcrumb generation.

#### 5. `POST /api/v2/search` (Global Search)

- **Returns:** `ListingItem[]`
- **Purpose:** Database-wide FTS (Full Text Search). This is distinct from the `filter` parameter on the children endpoint, which is scoped to a folder.

### Internal Logic & Schema Changes

#### 1. Decoupled Ingestion Logic

The logic for parsing structure (from `tv_parsing.md`) moves strictly to the `FilesystemService` (Phase 1).

- **Change:** `season_number` and `episode_number` are written during the filesystem scan.
- **Separation:** These fields represent the **Identity**. The **Description** (Title/Overview) is populated asynchronously.
- **API Implication:** The API serves whatever is in the DB. If Phase 2 (Enrichment) hasn't run yet, the API returns the item with `season_number` populated but `title` as null (or filename). The Frontend handles this gracefully (e.g., displaying "Episode 1" as a fallback title).

#### 2. User Edit Signals

- **Change:** When `PATCH /items/:id` modifies a structural field (`season_number`, `episode_number`, `tmdb_id`), the backend must automatically invalidate the metadata state (`tmdbDetailsFetched = false`).
- **Result:** This triggers the Metadata Service to refresh the description, ensuring the Title matches the new Episode Number.

#### 3. Pagination Logic

- **Strategy:** We will use **Offset-based pagination** (`LIMIT 50 OFFSET 50`) for Version 2.
- **Known Constraint:** "The Shifting Floor". If a new item is added to the DB (via scan) while a user is scrolling, indexes shift, and the user might see a duplicate item on the next page load.
- **Verdict:** This is acceptable for a personal media server. Cursor-based pagination is too complex to implement alongside random sorting/filtering requirements.

### Example Walkthroughs

**Example 1: Deep Navigation (The "Double Fetch")**
_Scenario: User right-clicks a "Season 1" tab inside a Show view and selects "Open Detail View"._

1.  **Frontend:** Navigates to `/item/season-123-uuid`.
2.  **Frontend:** Fires two requests in parallel:
    - **Fetch Details Immediately:** `GET /api/v2/items/season-123-uuid?include=overview,path,genres`
    - **Fetch Content Immediately:** `GET /api/v2/items/season-123-uuid/children`
    - **Fetch Credits On Interaction/Scroll:** `GET /items/season-123-uuid?include=people` (Only fetched when scrolling to Cast & Crew section or clicking the tab).
3.  **Backend (Details):** Returns `LibraryItem` (Fully populated as requested: Title="Season 1", Overview, Cast). Frontend renders the header immediately.
4.  **Backend (Content):**
    - Recognizes parent is a Season.
    - Queries DB: `SELECT * FROM items WHERE parent_id = 'season-123-uuid' ORDER BY episode_number ASC`.
    - Returns `LibraryItem[]` (Minimal: ID, Name, Poster, EpisodeNumber).
    - Because no `?include=` was passed, `overview` and `people` are `undefined` in the children array.
5.  **Frontend:** Renders the grid of episodes using the minimal data. No client-side sorting or parsing required.

**Example 2: Server-Resolved Virtual Grouping**
_Scenario: The library is configured to display as "Tabs", grouped by a custom virtual tag `is_animation`._

1.  **Fetch Groups (Implicit Selection):**
    - Frontend requests: `GET /api/v2/items/root/children` (Note: No `groupBy` param needed).
    - **Backend Logic**:
       - Resolves Root settings -> finds `layout: tabs`, `groupBy: vt.is_animation`.
       - Performs grouping.
       - Notice "Animation" group has its own `childViewSettings`: `groupBy: mediaType`.
       - **Recursive Step**: Backend automatically groups children of the "Animation" folder by `mediaType`.
    - **Response**:
      ```json
      [
        {
          "id": "virtual--root--vt.is_animation:Yes",
          "name": "Animation",
          "type": "folder",
          "children": [
             { "id": "...", "name": "Movies", "type": "folder", "children": [...] },
             { "id": "...", "name": "TV Shows", "type": "folder", "children": [...] }
          ]
        },
        {
          "id": "virtual--root--vt.is_animation:No",
          "name": "Live Action",
          "type": "folder",
          "children": [...]
        }
      ]
      ```
2.  **Render UI:**
    - The `MediaView` component renders a `TabsView`.
    - `TabsView` receives the pre-nested structure and renders the top-level tabs.
    - Because the data is already nested, the UI can render the sub-sections (Movies/TV) immediately without additional network requests.

## 5. Edge Cases & Unresolved Questions

- **Virtual Folder Details:** What happens if we request `GET /api/items/virtual:genre:Action`?
  - **Decision:** The backend must synthesize a `LibraryItem` (fully populated). Title = "Action", Backdrop = Default/Random from children. Path = null. Settings = inherited from the physical root parent.
- **Empty Folders:**
  - **Decision:** The backend should default to returning them, but we may add a `?hideEmpty=true` param later.
- **Navigation Loop:** What if a Virtual Folder points to an item that is its own ancestor?
  - **Decision:** Since navigation is ID-based and flat, loops are visually impossible in the breadcrumb/stack (you just go deeper into a new context), but we must ensure `ancestors` endpoint handles virtual paths correctly (reconstructing the logical path, not physical).
- **Playback Context ("The Sibling Problem"):** In a paginated/lazy-loaded view, the client does not know what the "Next" item is if it falls on the next page.
  - **Decision:** We strictly use the `POST /queues` endpoint. The client does not calculate the next sibling. The server returns a list of IDs. This also handles complex logic like jumping from "Season 1 Finale" to "Season 2 Premiere" without the client needing to load the Season 2 folder structure.
- **Tree View Pagination:** The Tree View component expands folders in-place. If a folder has 2,000 items, we cannot fetch all of them without freezing the UI, nor does standard "window" scrolling apply easily to nested nodes.
  - **Decision:** The Tree View will support a "Load More" button (or click-to-paginate) at the bottom of expanded lists that exceed the default page size (e.g., 50 items).
- **Horizontal Infinite Scroll:** Used for "Next Up" and configured Horizontal Grid views.
  - **Decision:** The frontend `HorizontalGridView` component must implement intersection observers to trigger `GET /children?offset=X` when scrolling sideways, similar to vertical infinite scroll.
- **Massive Playlists:** Right-clicking a folder with 10,000 items and selecting "Play All".
  - **Decision:** For now, the server will return the full list of 10,000 IDs. This is approximately 360KB of JSON, which is acceptable for a specific user-initiated action. If this becomes a bottleneck, we will move to a server-side "Active Playlist Session" model.

## 6. Client-Side Architecture Requirements

To prevent UX regressions during the move to an async architecture, the Frontend **must** implement the following patterns:

### 1. The Async Gap & Scroll Restoration

Browsers cannot restore scroll position on "Back" navigation if the page renders as empty while waiting for `fetch()`.

- **Requirement:** The Frontend must implement a **Client-Side Cache Store** (e.g., a Svelte Store or TanStack Query).
- **Logic:**
  1.  User navigates to `Folder A`. Fetch data. Store in Cache: `Map<FolderID, { items: [], scrollY: 0 }>`.
  2.  User scrolls down. Update `scrollY` in Cache.
  3.  User clicks Item. Navigates away.
  4.  User clicks Back.
  5.  **Critical Step:** Component mounts. Checks Cache. Finds data. **Renders synchronously.**
  6.  Browser restores scroll position successfully because DOM height is restored immediately.

### 2. "Soft Refetching" for Updates

We reject the complexity of manually patching client-side arrays (e.g., "User renamed item X, move it from index 5 to 10").

- **Strategy:**
  1.  User performs action (Rename, Edit Metadata).
  2.  Client sends `PATCH` request.
  3.  Client triggers a **Background Refetch** of the current view (all currently loaded pages).
  4.  The UI framework (Svelte) diffs the new data against the DOM.
  5.  The item snaps to its new position or disappears (if filtered out) automatically.

### 3. Context-Aware Navigation

When navigating deep into Virtual Folders (e.g., `Root > Genre: Action > The Matrix`), the physical `parentId` of the movie "The Matrix" is likely `Root > Movies`, not the virtual "Action" folder.

- **Requirement:** The Frontend must maintain a **Navigation Context** in its history state.
- **Logic:**
  - When clicking an item, pass the _current view's ID_ as the context.
  - The Detail View uses this context to generate the "Back" link / Breadcrumb, ensuring the user returns to "Action Movies" and not "All Movies".

## 7. Performance Considerations

- **Impact on Core Operations:**
  - **Initial Load:** Drastically faster. We only fetch the root's direct children (50-100 items) instead of the whole DB (5,000+ items).
  - **Navigation:** Slightly "chattier" (network latency applies to every folder click), but rendering is consistently 60fps because the main thread isn't processing huge arrays.
- **Scalability:**
  - This architecture scales linearly with database size. A library of 100,000 items is just as fast as 100 items, provided the SQL queries are indexed and pagination is used.
- **Resource Usage:**
  - **Client RAM:** Significant reduction (-90% for large libraries).
  - **Server CPU:** Slight increase due to more frequent SQL queries, but SQLite is optimized for this.

## 8. Alternatives Considered

- **Alternative A: GraphQL**
  - _Why Rejected:_ Adds significant complexity to the build stack and runtime. We can achieve the "fetch only what we need" goal with specific REST DTOs (`ListingItem`) without the overhead of a GQL resolver engine.
- **Alternative B: Combined Response (Details + Children)**
  - _Why Rejected:_ While it saves one HTTP request, it couples the two data types. If we paginate children (Page 2, Page 3), we don't want to re-send the Header/Detail data every time. Splitting them allows for better caching strategies (e.g., cache Details for 5 minutes, cache Children for 10 seconds).
- **Alternative C: Client-Side "Tree Patching"**
  - _Why Rejected:_ Sending "diffs" of the tree to the client is complex to maintain and prone to synchronization bugs. It is cleaner to treat the view as stateless and fetch the current state of a node when needed.
