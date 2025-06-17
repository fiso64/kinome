### **TV Show Data Mapping**

#### **Guiding Principles**

*   **Local First, API Second:** The app will first analyze the local file structure to assign season/episode numbers and only then fetch API data to enrich it.
*   **Data Consolidation:** We will reuse existing `LibraryItem` fields (`title`, `overview`, `posterPath`) for episode-specific data to avoid data model redundancy.
*   **Efficient, On-Demand Fetching:** Fetching is done in two stages: a single show-level request for season info, and lazy-loaded episode requests only when a season is expanded.
*   **Pragmatism:** The system will handle common file structures predictably. The README will guide users on best practices for folder organization.

---

### **Phase 1: Foundation & Data Model**

**Objective:** Adapt data structures to support seasons and episodes.

*   **Task 1: Enhance Data Model (`src/main/types.ts`)**
    *   Add to `MediaFile`:
        ```typescript
        seasonNumber?: number;
        episodeNumber?: number;
        ```
    *   Add to `MediaFolder` (for both TV Show root and Season subfolders):
        ```typescript
        // For the TV Show root folder
        tmdbSeasons?: any[]; // Caches the array of season objects from TMDB
        // For Season subfolders
        tmdbEpisodeDataFetched?: boolean; // Tracks if episode API call has been made
        ```

---

### **Phase 2: Local File Analysis (No API Calls)**

**Objective:** Implement the core logic that analyzes a show's folder structure to assign `seasonNumber` and `episodeNumber` to its immediate children *before* any API calls.

*   **Task 2: Implement the TV Show Mapping Pipeline (`src/main/library.ts`)**
    *   **Trigger:** This pipeline runs when a folder identified as `mediaType: 'tv'` is processed (e.g., during a refresh or when its detail page is opened). It operates on **immediate children only** and does not recurse.
    *   **Heuristic 1: "Immediate Files" Rule:** If the show's root folder contains media files, lock into "File Mode".
        *   **High-Confidence Parse:** Attempt to parse SxxExx patterns from all filenames. If successful, use the parsed numbers.
        *   **Alphabetical Fallback:** If parsing fails, assign all files to **Season 1** and assign `episodeNumber` based on an alphabetical sort of filenames.
    *   **Heuristic 2: "Patterned Subfolders" Rule:** If no immediate files are found, scan subfolder names for season patterns (e.g., "Season 01"). Assign `seasonNumber` to matching folders.
    *   **Heuristic 3: "Alphabetical Subfolders" Rule (Final Fallback):** If other heuristics fail, assign `seasonNumber` to all subfolders (excluding "Extras", etc.) based on an alphabetical sort of their names.

---

### **Phase 3: On-Demand Metadata Fetching & Mapping**

**Objective:** Fetch data from TMDB only when needed and map it to the local items.

*   **Task 3: Show-Level Metadata Fetch & Mapping**
    *   **Trigger:** Immediately after the local pipeline (Task 2) runs on a TV show's root folder.
    *   **API Action:** Make a **single API call** to `/tv/{tv_id}`.
    *   **Caching:** Store the returned `seasons` array into the show folder's `tmdbSeasons` property and save it to the database.
    *   **Mapping Scenarios:**
        *   **Scenario A (Season Folders):** If Task 2 identified season folders, iterate through them. Match each folder's `seasonNumber` to a season object in the cached `tmdbSeasons` array. Apply the season's `name` (as `title`) and `overview`, and download its `poster_path`. The UI now shows rich season folders.
        *   **Scenario B (Immediate Files):** If Task 2 resulted in "File Mode" (all files in Season 1), make an **additional API call** to `/tv/{tv_id}/season/1`. Match the returned episode list to the local `MediaFile` objects based on their `episodeNumber` (from the alphabetical sort) and apply the episode's `name` (as `title`), `overview`, and `still_path` (as `posterPath`).

*   **Task 4: Episode-Level Metadata Fetch & Mapping (Lazy Loaded)**
    *   **Trigger:** When a user expands or navigates into a **season folder** for the first time.
    *   **Check:** See if the season folder has `tmdbEpisodeDataFetched: true`. If so, do nothing.
    *   **Local Action:** If not yet fetched, first assign `episodeNumber` to all immediate child files within this season folder based on an alphabetical sort. This allows the UI to render the file list instantly.
    *   **API Action:** Make an API call to `/tv/{tv_id}/season/{season_number}` for that specific season.
    *   **Mapping:** Match the returned episode list to the local `MediaFile` children using `episodeNumber`. Apply the episode's `name` (as `title`), `overview`, and download the `still_path` (as `posterPath`).
    *   **Caching:** Set `tmdbEpisodeDataFetched: true` on the season folder and save to the database to prevent future API calls for this season.

Note: For easier debugging, please log whenever a tmdb api request is made to any endpoint for whatever reason.
