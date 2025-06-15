
# Project Idea

A unified media browser with support for multiple sources.

#### Core Ideas

*   **Sources:** The application can browse media from multiple locations, such as local file systems, Rclone remotes, and Jellyfin servers. Each source is treated as a pluggable module.
*   **Flexible Folder Structure:** The application makes no assumptions about how media files are organized. Whether movies and shows are in separate folders, mixed together, or deeply nested, the scanner will process them accordingly.
*   **Library Data Directory:** The application does not pollute the user's media folders. All metadata, images, tags, and state are stored in a single, user-defined "Library Data Directory." This can be a local folder or a remote location (e.g., on the same Rclone remote as the media). This directory acts as a cache and an overlay, containing:
    *   A central `database.json` file as the app's source of truth. This file will store the **full hierarchical structure** of the library, mapping out folders, their sub-folders, and their media files. This tree representation is essential for enabling flexible UI views.
    *   An `images/` folder for all downloaded posters and backdrops.
*   **Stable Identification:** To track media across renames or sessions, each file and folder is given a stable, unique internal ID, typically a hash of its path relative to the library root.

#### Metadata & Retrieval

For sources that don't provide rich metadata (like local files or Rclone), the application will fetch it from external services.

*   **Retrievers:** Metadata fetching is handled by an abstract "Retriever" system, initially supporting only The Movie Database (TMDB).
*   **Scanning:** On startup or manual trigger, the app scans the source. New items are added to the database. A background process then enriches these items with metadata from the configured retriever, respecting the per-folder settings below.
*   **Disambiguation:** The app will use heuristics (file/folder names, TMDB's multi-search) to guess if an item is a movie or a TV show. The user will have a simple UI to correct any misidentifications and manually select the correct metadata and artwork.

*   **Selective Retrieval Configuration:** Users need fine-grained control over what gets a metadata lookup. A structural folder like `media/movies` should not have its own metadata fetched, but its children should. This is handled by per-folder settings. We'll also add optional hints for folders to tell the retriever what type of media its children are likely to be. This significantly improves matching accuracy and reduces ambiguity. For example, a user would configure their `media/tv shows` folder to enable metadata retrieval and set the children type hint to tv show.

#### Video Player

The application will not include a built-in media player. The user defines the exact command-line to execute their preferred player (e.g., MPV, VLC). The user's command will include a placeholder (e.g., `{URL}` or `{PATH}`) which the application replaces with the appropriate playable link or file path for the selected media item. This is essential for sources like Rclone that require a specific serving URL.

#### Organization & State

*   **Libraries:** The root unit of organization is a library, which is a combination of a media source configuration and the path to its corresponding Library Data Directory. The application will be designed to support multiple libraries in the future.
*   **Watched State:** Watched status is tracked within the app's `database.json`. To keep things simple initially, an item will be marked as "watched" as soon as the user attempts to play it (a "fire and forget" approach).
*   **Tagging:** Users can apply custom tags to any media item. These tags are stored in the database and can be used for searching, filtering, and structuring the UI. For sources like Jellyfin, these tags will live exclusively in the app's Library Data Directory.

#### User Interface

*   **Flexible Media List:** This is the core UI component, designed to be reusable and highly configurable for displaying a list of items (which can be folders or media files). Items can be sorted or filtered based on metadata or custom tags. The user can define the UI structure based on folder hierarchy, metadata (`media_type`, `genre`), or custom tags. This is achieved by the backend preparing a structured "view model" for the UI to render.
 
 Every node in the library's hierarchy, regardless of depth, can have its own detail page. The component supports several rendering strategies:

    **View Modes:**
    *   **Grid View:** The classic view. Displays items as posters with titles underneath. Clicking an item navigates to its detail page. This is ideal for visual browsing of movies or TV shows.
    *   **Tree View:** A hierarchical list, with folders (nodes) that can be expanded or collapsed to show their children. Clicking on any node can navigate to its detail page. This is useful for exploring complex folder structures.

    **Layout Strategies (per-level configuration):**
    At any level in the folder hierarchy, the user can define *how* the children of that folder are presented. This configuration is stored in the database for that folder. The options are:
    1.  **Grid:** Renders the children using the **Grid View**.
    2.  **Tree:** Renders the children using the **Tree View**.
    3.  **Tabs:** Renders each child folder as a clickable tab. The selected tab then displays the contents of *that* folder, using one of the other layout strategies (e.g., a grid of movies).
    4.  **Sections:** Renders each child folder as a named section header, followed by its contents (e.g., in a grid). This allows for multiple categories to be displayed on a single, scrollable page.

    By default, the initial view of a library will show only its **immediate children** (the top-level folders and files).
*   **Item Detail View:** Clicking an item opens a clean, modern detail page showing its backdrop, poster, metadata, and other information. To display the contents of a folder or a show, this view will **reuse the same flexible media list component** from the main view. However, its default presentation for contents will be a "tree view," allowing the user to expand nested folders directly or click to navigate into them.