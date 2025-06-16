# High-Level Development Plan

This plan prioritizes getting a useful Minimum Viable Product (MVP) working with a local file source, then iteratively adding features.

#### Phase 1: The Foundation - MVP with Local Files

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

#### Phase 2: Adding Intelligence & Polish

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

#### Phase 3: Core Feature Completion 

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
*   `[ ]` **Manual Metadata Search:** Build the UI for users to search TMDB manually, and select the desired movie/show from a list of results (search can be performed for a movie or tv show, not multi). The result list should also show posters of each result (take a smaller thumb).
    *   Allow also to search for posters and backdrops. Show the result image list. Allow selecting the language (default en, can be none)
    *   The current poster and backdrop should always be shown in the window
    *   Also allow to select a local image as backdrop or poster (will be copied to the database).
    *   Add manual search as context menu entry

#### Phase 4: Expansion & Refinement

The goal is to expand source support and prepare for future growth.

*   `[ ]` **Add Rclone Source:** Implement a new `Source` module for Rclone. This will involve using the Rclone CLI and the user-defined URL template for playback. This will be the first major test of the `Source` abstraction.
*   `[ ]` **Add Jellyfin Source:** Jellyfin will differ from rclone and local path sources due it (hopefully) providing most metadata already. Automatic TMDB retrieval might become disabled for jellyfin. If the user decides to add custom tags, metadata or images, we will still have to store them and "enrich" the data returned by jellyfin with our stored values. 
*   `[ ]` **Flexible UI Engine, Part 2:** Allow grouping by arbitrary tags or metadata in the media list, not just folder names.
    *   Filtering items from view depending on conditions
*   `[ ]` **Multi-Library Support:** Refactor the codebase to handle multiple library configurations instead of just one.
*   `[ ]` **(Future) Database Migration:** If performance with the `database.json` becomes an issue for very large libraries, plan and execute the migration to an SQLite-based database module. Thanks to the abstraction in Phase 1, this should not require major changes to the rest of the application.
