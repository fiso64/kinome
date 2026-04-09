# Kinome Plan

### 🏗️ Core Architecture & Performance
- [X] Clean up the API and optimize. Currently sends huge amount of data even though most of it is frequently not needed. Should be smarter and much more on-demand. Must rethink from scratch and adopt a good pattern.
- [ ] Monitor option: Rescan on startup and watch filesystem for changes, rescan on change.
  - [X] Need to ensure rescan is non-destructive, always. (Probably already the case, see `spec/backend/metadata_locking.md`)
- [ ] Optimization
  - [X] Migrate to bun.
    - [X] Use bun:sqlite instead of better-sqlite3, and maybe replace other dependencies by bun stuff (if available).
  - [ ] Consider migrating to another db for concurrent writes (e.g. postgres). Not sure if necessary.
  - [ ] Optimize the backend to be super fast for all reasonable scenarios.
  - [ ] Optimize the frontend to load super quickly.
    - [ ] Pagination everywhere (but still have seamless infinite scrolling).
- [ ] See if it's possible to expose a jellyfin-compatible API as an alternative. This might give cross platform support + TV app for free. <a id="alt-api"></a>

### 🎬 Playback & Transcoding
- [ ] Transcoding and transmuxing support (look into jellyfin's implementation).
- [ ] Refine players.
  - [ ] Add support for mpv.conf or other types of player config files in the media directory. How to handle them?
  - [ ] Look at the percentage watched to determine if an item is watched or not, instead of setting immediately on play. Look into how jellyfin does it.
  - [X] Re-enable custom player feature by adding a custom protocol (supports calling the defined player with the defined commands).
    - [X] For this feature to work, users will have to install a protocol handler on their device. Make this process user-friendly.
  - [ ] Web player, Capabilities detection decision engine. (Requires transmuxing/transcoding support) (libs: hls.js, vidstack, JavascriptSubtitlesOctopus)
- [ ] Cast support (DLNA / UPnP, Chromecast). (Chromecast likely requires transmuxing support)

### 🎨 UI/UX, Customization
- [ ] Improve and polish UI everywhere.
  - [ ] Different styling for nested sections and tabs. Subsections should have a different style than top-level sections.
  - [ ] Replace the top toolbar by a cleaner sidebar. No more search bar (instead: looking glass icon in the sidebar).
  - [X] Think of some convenient browser-compatible shortcuts for common actions.
  - [ ] Redesign the entire UI and make everything more consistent (centralized css definitions and ui elements), polished, pretty, modern, etc.
  - [ ] Command palette.
- [X] Dynamic/"virtual" tags. Grouping and searching by virtual tags. (MusicBee-style)
- [X] Full virtual filesystem. See `spec/backend/virtual_filesystem.md`. This will enable features like:
  - [X] Refactor virtual folders to be first-class database citizens. Other services should be able to work with them identically to normal folders.
    - [X] Start by implementing real virtual folders alongside current transient virtual folders.
    - [X] Then refactor to unify the two types of virtual folders.
  - [X] A way to represent a structure with `root/tv shows` and `root/movies` directly in home view (pooling).
  - [X] A "Recently Added" section implemented as a virtual folder.
  - [X] Improve default home view. Add a recently added default virtual folder. 
  - [ ] Show multiple default setup options during onboarding.
- [ ] More UI and virtual tag configuration.
  - [X] Sorting and filtering any view by anything (metadata, tags, virtual tags).
  - [ ] Dynamic virtual tag values (see `docs/draft-field-references-in-vtag-results.md`).
  - [ ] See how Jellyfin's home view looks and add customization options to allow users to recreate this look (if it's good).
- [ ] Improve navigation and user action performance as much as possible. Remove all lag and jitter.
- [ ] Revive the custom actions feature. Support both client-side and server-side action definitions.
- [ ] Themes.

### 📚 Library & Metadata
- [ ] Retrieve and save more local metadata using ffprobe (or similar), e.g. video file durations, mkv available audio and subtitle languages, etc. 
  - [ ] Make it all searchable and accessible in virtual tag definitions like every other piece of metadata.
- [ ] UI to manage metadata locks (add or remove)
- [ ] A "Notes" text field? Or star rating field? Or custom field definitions? 
- [ ] More metadata providers aside from TheMovieDB? (TVDB, AniList, etc.)
- [ ] Manual episode assignment. See `docs/TODO-expanded.md#manual-episode-assignment`

### 🔐 Auth & Multi-User
- [X] Start with support for authentication for the default account. Secure all endpoints.
  - [X] Add common server-related settings like the port and allowed IPs. Note: Can omit https for now, every sane man uses a reverse proxy.
  - [X] A nice login page.
  - [X] Browser caching of auth token.
  - [X] Ensure everything is secured. Also ensure that the copied stream URLs still work.
- [ ] Multi-account support (see `docs/multi-account-plan.md`)
  - [ ] Implement basic multi-account support with normal and admin roles and per-user watched state.
  - [ ] Allow locking normals to a particular library filter (e.g. user A can only see media that has a particular tag).
  - [ ] Create a virtual home folders for each user, owned by them. Normals can fully edit their own folders but not others' (unix-like ownership).
  - [ ] UI for sharing folders and accessing shared folders.
    - [ ] Store more settings (like layout and sort by) per-user to allow normals to modify appearance even for shared folders.

- [ ] Tighten security.
  - [ ] Short-lived tokens for streaming

### 📱 Platform Support
- [ ] Make the web UI display good on different screen sizes.
- [ ] TV app. (See first: [Alternative API](#alt-api))
- [ ] Revive electron app (built-in server + thin client)?

### ⌨️ Diagnostics & Development
- [ ] Frontend should display error messages from the backend when needed (?)
- [ ] Improve testing coverage
    - [X] Add many tests for the backend
    - [ ] Maybe mock the backend and add frontend tests.
- [ ] Use a good logging framework with pretty output and multiple log levels.
- [ ] (Maybe) Use YAML instead of JSON for settings and library-settings.

## Future

- [ ] Plugin System: Implement a versatile plugin system. Searcher plugins (browsing tmdb?), downloader/streamer plugins (downloading from various trackers?), etc.
  - Very similar to Stremio ([look into it](https://guides.viren070.me/stremio)):
    1. A searcher plugin will allow searching for media that isn't in the local library (e.g. tmdb search plugin)
    2. A downloader/streamer plugin will be required to play any items not in the local library (e.g.: a https stream plugin returning https stream link(s), torrent downloader plugin returning results from a particular tracker). Downloader plugins should also allow one to permanently add a movie/show to the local library. In the spirit of the app, we should make it use an external torrent client (user-configured, similar to existing video player configuration) instead of a built-in one, if possible.
    3. If possible, make Stremio plugins work out of the box with kinome.
    4. The existing local files searching and playing logic might be refactored into yet another searcher and "streamer" plugin respectively.
