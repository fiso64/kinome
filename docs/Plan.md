# Kinome Plan

### 🏗️ Core Architecture & Performance

- [x] Clean up the API and optimize. Currently sends huge amount of data even though most of it is frequently not needed. Should be smarter and much more on-demand. Must rethink from scratch and adopt a good pattern.
- [ ] [P1] Monitor option: Rescan on startup and watch filesystem for changes, rescan on change. Rescan only what's needed, do not always run an expensive full rescan,
  - [x] Need to ensure rescan is non-destructive, always. (Probably already the case, see `spec/backend/metadata_locking.md`)
  - [ ] Introduce a public scoped rescan API.
- [ ] [P1] Optimization
  - [x] Migrate to bun.
  - [ ] Optimize rescan performance and responsiveness, especially with multiple hdd  media sources.
  - [ ] Optimize the backend to be super fast for all reasonable scenarios.
  - [ ] Optimize the frontend to load super quickly.
- [ ] [P0] Pagination everywhere (vertical lists, horizontal lists, arbitrarily nested sublists, etc), but still have seamless infinite scrolling).
- [ ] [P2] Expose a full jellyfin-compatible API as an alternative. Any jellyfin apps (android, tv) as well as other services like the arrs should work seamlessly when  given the correct root endpoint. Keep separate under a different endpoint, don't mix with our api. <a id="alt-api"></a>
  This will require adding and translating many of jellyfin's features, and might hide a bunch of decisions.
  The idea is support most of but not necessarily all of jellyfin's API. Enough for common integrations (seerr, sonarr, radarr, jellyfin clients, wholphin, moonfin) to work seamlessly.

### 🎬 Playback & Transcoding

- [x] [P1] Transcoding and transmuxing support.
- [ ] [P1] Refine players.
  - [ ] Look at the percentage watched to determine if an item is watched or not, instead of setting immediately on play. Look into how jellyfin does it.
  - [ ] Add a better integration for mpv (and vlc if possible) that reports accurate progress and allows navigating to the previous item in a playlist. E.g. using ipc+wrapper or lua scripts. Should be as easy to set up/run as possible. 
  - [x] Re-enable custom player feature by adding a custom protocol (supports calling the defined player with the defined commands).
    - [x] For this feature to work, users will have to install a protocol handler on their device. Make this process user-friendly.
  - [ ] Web player, Capabilities detection decision engine. (Requires transmuxing/transcoding support) (libs: hls.js, vidstack, JavascriptSubtitlesOctopus)
    - [ ] Cast support (DLNA / UPnP, Chromecast). (Chromecast likely requires transmuxing support)
- [ ] [P1] Default audio and sub language option. Requires: Metadata extraction to display available options. Allow passing chosen default to custom players.
  - [ ] Somehow support external sub files near videos, in both web and external players.

### 🎨 UI/UX, Customization

- [ ] [P2] Redesign the UI.
  - [ ] Different styling for nested sections and tabs. Subsections should have a different style than top-level sections.
  - [ ] Replace the top toolbar by a cleaner sidebar. No more search bar (instead: looking glass icon in the sidebar).
  - [x] Think of some convenient browser-compatible shortcuts for common actions.
  - [ ] Redesign the entire UI and make everything more consistent (centralized css definitions and ui elements), polished, pretty, modern, etc.
  - [ ] Command palette.
- [x] Dynamic/"virtual" tags. Grouping and searching by virtual tags. (MusicBee-style)
- [x] Full virtual filesystem. See `spec/backend/virtual_filesystem.md`. This will enable features like:
  - [x] Refactor virtual folders to be first-class database citizens. Other services should be able to work with them identically to normal folders.
  - [x] A way to represent a structure with `root/tv shows` and `root/movies` directly in home view (pooling).
  - [x] A "Recently Added" section implemented as a virtual folder.
  - [x] Improve default home view. Add a recently added default virtual folder. 
  - [ ] Show multiple default setup options during onboarding.
- [ ] [P1] More UI and virtual tag configuration.
  - [x] Sorting and filtering any view by anything (metadata, tags, virtual tags).

  - [ ] Dynamic virtual tag values (see `docs/draft-field-references-in-vtag-results.md`).

  - [ ] Introduce a simple syntax for defining folder conditions and vtags and remove the current clunky configuration UI. All variables can be thought of as implicitly prefixed with `item.`
    Home library condition:

    ```python
    parent.retrieve_children_metadata 
      or media_type == 'movie' 
      or media_type == 'tv' 
    ```

    _home_category vtag:

    ```python
    if 'Animation' in genres:
      if media_type == 'movie':
        value = 'Animated Movies'
      elif media_type == 'tv':
        value = 'Animated Shows'
    else:
      if media_type == 'movie':
        value = 'Movies'
      elif media_type == 'tv':
        value = 'TV Shows'
    
    # Lines starting with # are comments
    # Code must explicitly assign value,
    # can be empty.
    
    if value == '':
      value = 'Uncategorized'
    ```

    The editor should have syntax highlighting, completions (e.g. typing `media_type =` should show all completions immediately, selecting any should insert `'type'`; should work in partial case `'typ` to and show the `type` completion). Editor must also show errors and prevent saving broken definitions. The code must be compiled in some way; do not run an interpreter when evaluating vtags and conditions as this will kill performance.
- [ ] Improve navigation and user action performance as much as possible. Remove all lag and jitter.
- [ ] Revive the custom actions feature: Support server-side scripts and expose them through the UI in the actions menu for admins.
- [ ] Add support for custom links, which opens a link with templated values.
- [ ] Themes.

### 📚 Library & Metadata

- [ ] [P1] Improve filename extraction, handle many more patterns. Check Kyoo's approach.
  - [ ] In particular: Handle decimal episodes (20.5)
- [x] [P1] Retrieve and save more local metadata using ffprobe (or similar), e.g. video file durations, mkv available audio and subtitle languages, etc.
  - [x] Make it all searchable and accessible in virtual tag definitions like every other piece of metadata.
- [ ] [P1] Decide how to represent multiple same media items in different locations. E.g. `source1/tv show X/season 1/`, `source2/tv show X/season 2/`. 
- [ ] [P2] UI to manage metadata locks (add or remove).
- [ ] A "Notes" text field? Or star rating field? Or custom field definitions? 
- [ ] More metadata providers aside from TheMovieDB? (TVDB, AniList, etc.). See Kyoo.
- [ ] Manual episode assignment. See `docs/TODO-expanded.md#manual-episode-assignment`. What to do when episodes are completey wrong?

### 🔐 Auth & Multi-User

- [x] Start with support for authentication for the default account. Secure all endpoints.
  - [x] Add common server-related settings like the port and allowed IPs. Note: Can omit https for now, every sane man uses a reverse proxy.
  - [x] A nice login page.
  - [x] Browser caching of auth token.
  - [x] Ensure everything is secured. Also ensure that the copied stream URLs still work.
- [x] Multi-account support (see `docs/multi-account-plan.md`)
  - [x] Implement basic multi-account support with normal and admin roles and per-user watched state.
  - [x] Allow locking normals to a particular library filter (e.g. user A can only see media that has a particular tag).
- [ ] [P2] Granular permission/capability flags for non-admin accounts.
- [ ] [P2] Normals should be able to create and remove their personal tags. How? Maybe separate "personal tags" entry in metadata for each user.
- [ ] [P2] Create a virtual home folders for each user, owned by them. Normals can fully edit their own folders but not others' (unix-like ownership). 
- [ ] UI for sharing folders and accessing shared folders.
  - [ ] Store more settings (like layout and sort by) per-user to allow normals to modify appearance even for shared folders.
- [ ] Admins should be able to filter their library too.
- [ ] [P1] Tighten security.
  - [ ] Short-lived tokens for streaming
- [ ] API tokens.

### 📱 Platform Support

- [ ] Make the web UI display good on different screen sizes.
- [ ] Implement [Alternative API](#alt-api) to get TV and mobile apps for free.
- [ ] Revive electron app (maybe with two working modes: built-in server / thin client)?

### ⌨️ Diagnostics, Development, Packaging

- [ ] [P0] Frontend should display error messages from the backend when needed (?)
- [ ] [P1] Improve testing coverage
  - [x] Add many tests for the backend
  - [ ] Maybe mock the backend and add frontend tests.
- [ ] [P0] Use a good logging framework with pretty output and multiple log levels.
- [ ] (Maybe) Use YAML instead of JSON for settings and library-settings.
- [ ] [P2] Full declarative configuration for nixos. Problem: UI config clashes with nix config. Solution: Nix configs is the default, ui configuration is treated as an override. Should be exposed cleanly, options resetable to daemon defaults. Declarative config should support provisioning users and their passwords (e.g. using standard password files, with agenix/sops) and also changing passwords, but not deleting users.
- [ ] [P0] Set up smoke tests with "tripwire" checks for the amount of data transferred and time taken (specific to my hardware?) when loading common pages with a non trivial media library. E.g., should not take

## Future

- [ ] Plugin System: Implement a versatile plugin system. Searcher plugins (browsing tmdb?), downloader/streamer plugins (downloading from various trackers?), etc.
  - Very similar to Stremio ([look into it](https://guides.viren070.me/stremio)):
    1. A searcher plugin will allow searching for media that isn't in the local library (e.g. tmdb search plugin)
    2. A downloader/streamer plugin will be required to play any items not in the local library (e.g.: a https stream plugin returning https stream link(s), torrent downloader plugin returning results from a particular tracker). Downloader plugins should also allow one to permanently add a movie/show to the local library. In the spirit of the app, we should make it use an external torrent client (user-configured, similar to existing video player configuration) instead of a built-in one, if possible.
    3. If possible, make Stremio plugins work out of the box with kinome.
    4. The existing local files searching and playing logic might be refactored into yet another searcher and "streamer" plugin respectively.
