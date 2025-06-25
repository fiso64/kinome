# Development Plan

This plan prioritizes getting a useful Minimum Viable Product (MVP) working with a local file source, then iteratively adding features.

### Phase 1: The Foundation - MVP with Local Files

*   `[X]` **Project Setup:** Basic Electron + Svelte project template is in place.
*   `[X]` **Database Abstraction (JSON):** Create the "database" module in the `main` process. It will be responsible for loading, querying, and saving a single `database.json`. It must be able to model the library as a hierarchical tree, storing folders and media files with their parent-child relationships.
*   `[X]` **Local Source Scanner:** Implement the core scanning logic. This should run in a background worker.
    *   It will recursively scan a user-configured folder.
    *   It will generate stable IDs for **both folders and files**.
    *   It will build a tree structure representing the full directory hierarchy and save this structure to the `database.json`.
*   `[X]` **Basic Media List UI Component:** Create a single, reusable Svelte component that can display items from the database. Initially, it will only support a "grid view." By default, this view will render only the **immediate children** of the library root, preventing a cluttered view of every single file at the top level.
*   `[X]` **Item Detail View:** Create a page that displays when an item is clicked. For now, it can be very basic, serving only as a way to reach the folder's files in order to test the playback functionality that we'll implement in the next step.
*   `[X]` **Player Integration:** Implement the "fire and forget" playback logic.
    *   Add a setting for the user's player command.
    *   When a user clicks an item in the grid, the app marks it as watched in the JSON file and launches the external player with the file path.
*   `[X]` **Basic Search:** Add a search bar that performs a simple text search on the titles in the database.

### Phase 2: Adding Intelligence & Polish

The goal is to make the app visually appealing and more informative.

*   `[X]` **TMDB Retriever:** Implement the first metadata retriever for TMDB.
    *   The background scanner will now call the TMDB API to fetch metadata for new items.
    *   The scanner will download poster images and save them to the `images/` subfolder in the Library Data Directory.
    *   Need to add configuration UI for the api key (`tmdbApiKey`)
    *   For now, only retrieve images of the immediate children of the root media directory.
*   `[X]` **Enhanced Media List UI:** Upgrade the media list component to display the fetched poster image instead of just the filename.
*   `[X]` **Item Detail View:** Improve the page that displays when an item is clicked, showing the poster, backdrop and full overview in a clean UI. **This page will reuse the Media List component** to show the item's contents, defaulting it to a simple list or tree view.
    *   First, implement tree view for the media list component
    *   Only download the backdrop when the item detail view is opened. Get the maximum quality backdrop possible.
    *   If there is other metadata needed that can not be retrieved in the single request during the initial scan, also only fetch it when the details view for that item is opened.
*   `[X]` Allow scanning for new items and updating database
    *   Replace the "Scan Library Folder" by a reload button (⟳). Animate it while reloading. Reloading will re-scan the media folder for new items and add them to the database and search tmdb for the items that have not been searched yet
    *   Items that fail to be found should have tmdbId key set explicitly to null (also during the initial scan), so that they are not searched again on refresh.
    *   Add F5 shortcut to reload
    *   Full rescan / Change library location should now be available through the settings. There should also be a dropdown to select the source type, for now with only one option (local path). When local path is selected in the dropdown, a path selection input should appear.
*   `[X]` Get more items like year and genre from tmdb and optionally display them in the detail view.
*   `[X]` Improve performance
    *   There is a very slight delay before the detail page shows.
    *   Why does the backdrop sometimes show with a slight delay even though the image is already locally cached?
    *   If not possible to improve backdrop performance, at least make it fade in smoothly (fade in will always be needed when it is first downloaded as a delay is unavoidable in that case).

### Phase 3: Core Feature Completion 

The goal is to implement the key features that make the app unique and powerful.

*   `[X]` **Custom Tagging:** Implement the ability for users to add/remove tags on the Item Detail page. 
    *   The UI should allow adding, removing or modifying any tag or metadata entry, including things that have been fetched from tmdb like title and genre and others. It should show as a modal window.
    *   Custom tags consist of a custom tag name, and a value for that tag.
*   `[X]` **Flexible UI Engine:**
    *   Implement the UI/backend logic for saving the chosen layout strategy (Grid, Tree, Tabs, Sections) for any folder.
    *   Heavily refactor the `Media List` component to be able to render its items using any of the four layout strategies based on the parent folder's configuration.
    *   This includes the logic for rendering tabs and section headers, which will themselves contain a nested instance of the `Media List` component.
*   `[X]` **Implement Per-Folder Metadata Settings:**
    *   Update the retriever to fetch recursively for every subfolder instead of just the immediate children of the root media dir. Update the retriever to check for and obey the `retrieve_children_metadata` and `children_type_hint` flags on a folder before processing its children. `retrieve_children_metadata` will be assumed to be false by default for every folder level unless manually enabled by the user (add new toggleable checkmark in the context menu).
    *   children type hint will be editable in the metadata window
*   `[X]` Improve the search bar
    *   Update the search bar to support searching by tags (e.g., `:mytagname:favorite` or `:genre:sci-fi`). After typing :, autocompletions for the tag key should be shown. After typing the second : (or accepting an autocompletion, in which case it should insert the :), autocompletions for the tag values should be shown. After typing the second : or accepting the autcompletion, the key value pair should turn into a rounded tile (similar to the genres in the detail view). Backspacing it should delete it entirely.
    *   Also: Search bar needs to filter tab/section contents instead of tabs/sections themselves when using tab or section view.
*   `[X]` **Manual Metadata Search:** Build the UI for users to search TMDB manually, and select the desired movie/show from a list of results (search can be performed for a movie or tv show, not multi). The result list should also show posters of each result (take a smaller thumb).
    *   Allow also to search for posters and backdrops. Show the result image list. Allow selecting the language (default en, can be none)
    *   The current poster and backdrop should always be shown in the window
    *   Also allow to select a local image as backdrop or poster (will be copied to the database).
    *   Add manual search as context menu entry
*   `[ ]` **Flexible UI Engine, Part 2** 
    *   `[X]` For tab and section views, allow defining the tabs or sections by arbitrary tags or metadata in the media list, not just folder names. (Store tab/section settings in "virtual folders")
    *   `[X]` "Virtual tags" (similar to MusicBee). Virtual tags are derived from metadata or custom tags. Add new tab in the settings for defining virtual tags, with key/values similar as in the custom tags section in metadata edit window. The values of the virtual tags will be expressions, possibly involving one or multiple metadata/custom tags ({genre}, {my-custom-tag}), and possibly involving functions which modify strings. E.g.: A virtual tag named "isAnimation" which is equal to "Animation" when the genre tag contains "Animation", and otherwise "Film". Virtual tags can be filtered by in the search bar or can be set as group by. Careful: They should not be included in autocompletions for custom tag keys.
    *   `[ ]` Filtering items from view depending on conditions [**postponed until database migration (p4)**]
    *   `[ ]` Sorting by arbitrary values, maybe custom sort (drag and drop) [**postponed until database migration (p4)**]
*   `[X]` Improve search bar
    *   `[X]` Unified deep search: Make the search bar search all media library (all immediate children union all descendants which have an image, or maybe ALL descendants. Think what to include.). When searching, no tabs or sections will be displayed: results will be shown in a new separate media grid element (let's default it to poster grid view), all in one place. 
    *   `[X]` Rank results according to how closely they match the query (need a very fast rank algorithm. maybe normalize + ngram?)
    *   `[X]` Add a smaller "filter" bar inside the media grid view, which will filter only the immediate children on the current tab, similar to how the search bar works currently. The filter bar should initially be a looking glass button and expand to a small search bar when pressed.
*   `[X]` add tighter integration with the local filesystem (e.g make it easy to reveal files in explorer and view file properties, delete). add these to the context menu after a separator. Also, make sure to use good abstractions for later, since some remote sources will not have these things (maybe each source defines the possible additional actions that are available for files and folders?). Ensure the explorer integration is cross-platform.
*   `[X]` Add a "continue watching" element. Modify the root media view and create a new element specifically for the root, which will host the continue watching element and the media view element below it. Also show the element in tv show folders detail view if they have been partially watched. Make it easy to permanently dismiss the continue watching element (in both root view and tv show detail view).

### Phase 4: Expansion & Refinement

The goal is to prepare for future growth.

*   `[ ]` Option to rescan on startup => Need to ensure rescan is non-destructive, always.
*   `[ ]` Split the main process into transport layer and service layer.
*   `[ ]` Database migration: Refactor to use SQLite as the central data store.
    -  **Data Access: The Repository Pattern**
        Instead of a single, massive `db` object, create a dedicated "repository" module (e.g., `src/main/repository.ts`). This module would be the *only* part of the application that knows how to talk to the database. It would expose an API like:
        *   `getItemById(id: string): LibraryItem`
        *   `getChildren(parentId: string): LibraryItem[]`
        *   `updateItem(item: Partial<LibraryItem> & { id: string }): void`
        *   `findItems(query: string): SearchResult[]`
    -  **Change Notification: Explicit Events (Replacing the Proxy)**
        The proxy's job is to detect changes and notify the UI. In a repository-based architecture, this becomes explicit and much more predictable.
        *   Any function in the repository that modifies data (like `updateItem`) would be responsible for two things: 1) executing the `UPDATE` SQL statement, and 2) explicitly sending an IPC event to the renderer with the updated data (`BrowserWindow.getAllWindows().forEach(...)`).
        *   This eliminates the "magic" and replaces it with clear, debuggable logic. 
    -  We will have to refactor the database structure to be relational (e.g a separate tmdb movies/shows/seasons table(s) instead of storing all that data in the folder node json) 
    -  Test the new database with rclone remotes (most remotes should support random access reads). With and without `--vfs-cache-mode full`.
*   `[ ]` Improve code maintainability and readability (particularly god components like `App.svelte`)
*   `[ ]` Improve navigation and user action performance as much as possible. Remove all lag and jitter.
    *   `[ ]` Optimize virtual tags. Each individual virtual tag should only be computed when needed and only for the necessary subset of items instead of the entire library. E.g: when displaying a tabbed view grouped by a virtual tag, only compute that specific tag for the immediate children only (this is sufficient to determine the layout) and cache the results. In the search results, if filtering by a particular virtual tag, only compute this tag as a last filtering step for the search results, not for the entire library.
    *   `[ ]` Consider IPC diffing to improve performance and prepare for network functionality.
*   `[ ]` Refine player support. More detailed watched states (including time) => integration with common video players like mpv, vlc. 
*   `[ ]` Improve and polish UI everywhere. Test on different screen sizes.
*   `[ ]` Abstract and generalize the code sufficiently to be able to deal with the differences between desktop, web, and mobile (android, ios).

#### Future
*   `[ ]` **Server Support:** 
    *   Decide: Integrate with existing servers (like jellyfin's), or make a custom one?
    *   For a custom server:
        *   `[ ]` Turn the main process into a server (with a distributable binary) that can be run on a remote and communicate.  
                  Note: The application should (still) NOT require a server for local libraries, and work entirely via IPC in that case.
        *   `[ ]` Implement common features like multi-user support, on-the-fly transcoding, etc. 
*   `[ ]` **True Cross-Platform:** Web? Android? iOS?
*   `[ ]` **Multi-Library Support:** Refactor the codebase to handle multiple library configurations instead of just one.
*   `[ ]` **Plugin System:** Implement a versatile plugin system. User data integration plugins (myanimelist?), searcher plugins (browsing tmdb?), downloader plugins (downloading from various trackers?), etc.
