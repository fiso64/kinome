
### **Unified Search**

The core principle is to **include more items in the search, but rank them intelligently**. Instead of trying to curate the *perfect* set of searchable items (which is brittle), we create a more inclusive search index and rely on a smart ranking algorithm to surface the most relevant results.

This approach will be implemented for the main search bar, providing a "deep search" across the entire library. The existing filtering behavior will be repurposed for a smaller, in-view "filter" bar.

**Step 1: Automated Index Synchronization (The "How")**

*   `[X]` **Status: Implemented.** We have successfully built the foundation for a synchronized search index using a **"Smart Database" architecture**.

*   **The Problem:** We needed to ensure that when any part of our app changes an item's data (e.g., `item.title = 'New Title'`), the search index would be updated automatically. Manually calling an update function after every change is error-prone and not maintainable.

*   **The Solution:** We wrapped our in-memory database object in a recursive JavaScript `Proxy`. This proxy acts as an observer, intercepting any data modifications. When any code sets a property on a library item, the proxy's `set` handler automatically triggers a function (`updateIndexForItem`) that can re-evaluate that specific item's standing in the search index. We also implemented a "bulk update" mode to prevent this from firing excessively during mass updates like the initial library scan or metadata fetching.

*   **Why We Did It:** This architecture **guarantees** that our search index is always synchronized with our source data. It decouples the data modification logic from the search indexing logic, making the code cleaner, more reliable, and impossible to "forget" to update.

**Step 2: Building the Search Index (The "What")**

*   `[ ]` **Status: Next Step.** Now that we can automatically update the index, we need to define *what* goes into it. On startup or library refresh, we will build a flat, in-memory search index containing a **denormalized** but optimized representation of all searchable items.

*   **Inclusion Philosophy:** By default, every item (file or folder) is a candidate for the index. We will add a few high-confidence rules to reduce noise (e.g., exclude items from special folders like `extras` or `specials`).

*   **Index Entry Structure:** Each entry in the index will be a small, self-contained object, storing the minimum data needed to filter, rank, and display a result. This includes the `id`, `title`, `posterPath`, filterable tags (`genres`, `year`, etc.), and a pre-calculated `staticScore`.

*   **Performance Rationale (The Cache Discussion):** We are intentionally **duplicating** a small amount of data from the main database into this flat array. While a "normalized" index storing only IDs would use less memory, it would be drastically slower. A search would require constant, slow lookups from the index back to the scattered-in-memory database tree, leading to a high number of **CPU cache misses**. By creating a denormalized, **contiguous array** of search entries, we ensure that the search function can operate with maximum **memory locality**. The CPU can load chunks of the index into its fast cache and process them sequentially, leading to far superior performance. Our proxy architecture handles keeping this duplicated data perfectly in sync.

**Step 3: The Smart Ranking Algorithm (The "Which")**

*   `[ ]` **Status: To be implemented alongside Step 2.** When a user searches, we will filter the index and then rank the results. An item's final score will be a combination of its inherent importance (`Static Score`) and how well it matches the query (`Match Score`).

`Final Score = Static Score + Match Score`

*   **A. Static Score (Pre-calculated Heuristics):** This gives each item a baseline "importance" score. It's calculated once when the item is added to the index.
    *   **Major Boost:** An item with a poster (`posterPath`) gets a very high score.
    *   **Minor Boosts:** Items with a `title` or items that are folders get smaller boosts.
    *   **Soft Deduplication:** A file whose parent is *also* a high-value item (e.g., an episode file whose parent show folder has a poster) receives a score penalty. This pushes individual files down the list when the main entry is also present.

*   **B. Match Score (On-the-fly Fuzzy Search):** This measures how well an item's title matches the user's query.
    *   We will use a lightweight fuzzy-search library (like Fuse.js) to compare the user's text against the `title` stored in the search index entry. This handles typos and partial matches gracefully.

**Step 4: UI and IPC Flow**

*   `[ ]` **Status: To be implemented after Steps 2 & 3.**

1.  A new IPC channel, `api.performSearch(query)`, will be created.
2.  When the user types in the main search bar, the UI will call this method, sending the current query text and tags.
3.  The main process will filter and rank its local `searchIndex` using the `Final Score` and return a small, sorted list of the top results. **Crucially, the large index itself is never sent over IPC.**
4.  The application will switch to a dedicated, flat search results view (a `MediaGrid`) to render the ranked results.

Future: A new, smaller "filter" bar will be added to the standard grid/tree views to provide the *current* functionality of filtering only the items in the immediate view.