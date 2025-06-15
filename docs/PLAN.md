# High-Level Development Plan

This plan prioritizes getting a useful Minimum Viable Product (MVP) working with a local file source, then iteratively adding features.

#### Phase 1: The Foundation - MVP with Local Files

The goal is to be able to browse and play movies from a single local folder, regardless of its internal structure.

*   `[X]` **Project Setup:** Basic Electron + Svelte project template is in place.
*   `[ ]` **Database Abstraction (JSON):** Create the "database" module in the `main` process. It will be responsible for loading, querying, and saving a single `database.json`. It must be able to model the library as a hierarchical tree, storing folders and media files with their parent-child relationships.
*   `[ ]` **Local Source Scanner:** Implement the core scanning logic. This should run in a background worker.
    *   It will recursively scan a user-configured folder.
    *   It will generate stable IDs for **both folders and files**.
    *   It will build a tree structure representing the full directory hierarchy and save this structure to the `database.json`.
*   `[ ]` **Basic Media List UI Component:** Create a single, reusable Svelte component that can display items from the database. Initially, it will only support a "grid view." By default, this view will render only the **immediate children** of the library root, preventing a cluttered view of every single file at the top level.
*   `[ ]` **Player Integration:** Implement the "fire and forget" playback logic.
    *   Add a setting for the user's player command.
    *   When a user clicks an item in the grid, the app marks it as watched in the JSON file and launches the external player with the file path.

#### Phase 2: Adding Intelligence & Polish

The goal is to make the app visually appealing and more informative.

*   `[ ]` **TMDB Retriever:** Implement the first metadata retriever for TMDB.
    *   The background scanner will now call the TMDB API to fetch metadata for new items.
    *   The scanner will download poster images and save them to the `images/` subfolder in the Library Data Directory.
*   `[ ]` **Enhanced Media List UI:** Upgrade the media list component to display the fetched poster image instead of just the filename.
*   `[ ]` **Item Detail View:** Create a new "page" that displays when an item is clicked, showing the backdrop and full overview. **This page will reuse the Media List component** to show the item's contents, defaulting it to a simple list or tree view.
*   `[ ]` **Basic Search:** Add a search bar that performs a simple text search on the titles in the database.

#### Phase 3: Core Feature Completion

The goal is to implement the key features that make the app unique and powerful.

*   `[ ]` **Manual Metadata Correction:** Build the UI for users to fix incorrect matches, search TMDB manually, and select their preferred artwork.
*   `[ ]` **Custom Tagging:** Implement the ability for users to add/remove tags on the Item Detail page. Update the search bar to support searching by tags (e.g., `tag:favorite`).
*   `[ ]` **Implement Per-Folder Metadata Settings:**
    *   Update the scanner to check for and obey the `retrieve_children_metadata` and `children_type_hint` flags on a folder before processing its children.
    *   In the Item Detail view for a folder, add UI controls to allow the user to set these two properties.

*   `[ ]` **Flexible UI Engine & Component:**
    *   Implement the UI/backend logic for saving the chosen layout strategy (Grid, Tree, Tabs, Sections) for any folder.
    *   Heavily refactor the `Media List` component to be able to render its items using any of the four layout strategies based on the parent folder's configuration.
    *   This includes the logic for rendering tabs and section headers, which will themselves contain a nested instance of the `Media List` component.

#### Phase 4: Expansion & Refinement

The goal is to expand source support and prepare for future growth.

*   `[ ]` **Add Rclone Source:** Implement a new `Source` module for Rclone. This will involve using the Rclone CLI and the user-defined URL template for playback. This will be the first major test of the `Source` abstraction.
*   `[ ]` **Multi-Library Support:** Refactor the codebase to handle multiple library configurations instead of just one.
*   `[ ]` **(Future) Database Migration:** If performance with the `database.json` becomes an issue for very large libraries, plan and execute the migration to an SQLite-based database module. Thanks to the abstraction in Phase 1, this should not require major changes to the rest of the application.
