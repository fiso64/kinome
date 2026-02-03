## Stuff

- `[X]` Clean up the API and optimize. Currently sends huge amount of data even though most of it is frequently not needed. Should be smarter and much more on-demand. Must rethink from scratch and adopt a good pattern.
- `[ ]` UI to manage metadata locks (add or remove)
- `[ ]` Refine player support.
  - `[X]` Watched status should no longer be updated when an item is merely clicked in the ui (e.g. copy to clipboard action). Instead, we update watch status only when we start streaming the item (backend should detect a stream automatically). This will also fix the issue where playing the next file in an external player (mpv, vlc) does not mark the next file as watched (have to manually mark as watched in the ui).
  - `[ ]` Add support for mpv.conf or other types of player config files in the media directory. How to handle them?
  - `[ ]` Look at the percentage watched to determine if an item is watched or not, instead of setting immediately on play. Look into how jellyfin does it.
  - `[ ]` Re-enable custom player feature by adding a custom protocol (supports calling the defined player with the defined commands).
    - `[ ]` For this feature to work, user will have to install a protocol handler on their device. Make this process user-friendly.
  - `[ ]` Web player
- `[ ]` Transcoding support (look into jellyfin's implementation).
- `[ ]` Monitor option: Rescan on startup and watch filesystem for changes, rescan on change.
  - `[X]` Need to ensure rescan is non-destructive, always. (Probably already the case, see `spec/backend/metadata_locking.md`)
- `[ ]` More UI and virtual tag configuration: Sorting and filtering any view by anything (metadata, tags, virtual tags).
  - `[ ]` See how Jellyfin's home view looks and add customization options to be able to recreate this state.
    - `[ ]` A way to represent a structure with `root/tv shows` and `root/movies` directly in home view (pooling configuration?)
    - `[ ]` A "Recently Added" section. Decide if its logic should be hardcoded or implemented as a built-in virtual tag of some kind.
- `[ ]` Revive the custom actions feature. Support both client-side and server-side action definitions.
- `[ ]` Improve navigation and user action performance as much as possible. Remove all lag and jitter.
- `[ ]` Improve and polish UI everywhere.
  - `[ ]` Remove the top toolbar, replace by a cleaner sidebar. No more search bar (instead: looking glass icon in the sidebar).
  - `[ ]` Think of some convenient browser-compatible shortcuts for common actions.
  - `[ ]` Redesign the entire UI and make everything more consistent (centralized css definitions and ui elements), polished, pretty, modern, etc.
  - `[ ]` Make it display good on different screen sizes.
  - `[ ]` Command palette.
- `[ ]` Optimization
  - `[ ]` Migrate to bun.
    - `[ ]` Use bun:sqlite instead of better-sqlite3, and maybe replace other dependencies by bun stuff (if available).
  - `[ ]` Consider migrating to another db for concurrent writes (e.g. postgres). Not sure if necessary.
  - `[ ]` Optimize the backend to be super fast for all reasonable scenarios.
  - `[ ]` Optimize the frontend to load super quickly.
- `[ ]` Account and Authentication support
  - `[ ]` Start with support for authentication for the default account. Secure all endpoints. Look into how jellyfin does it.
    - `[ ]` Add common server-related configuration like the port and allowed IPs. Note: Can omit https for now, every sane man uses a reverse proxy.
    - `[ ]` A nice /login page.
    - `[ ]` Browser caching of auth token.
    - `[ ]` Ensure everything is secured. Also ensure that the copied stream URLs still work.
    - `[ ]` Etc. (again, look how jellyfin does it).
  - `[ ]` Support for multiple accounts.
- `[ ]` Retrieve and save more local metadata using ffmpeg (or similar), e.g. video file durations, mkv available audio and subtitle languages, etc. 
  - `[ ]` Make it all searchable and accessible in virtual tag definitions like every other piece of metadata.
- `[ ]` A "Notes" text field? Or star rating field? Or custom field definitions? 
- `[ ]` Dev: Actually add comprehensive tests for the backend and frontend. Maybe mock the db for the frontend tests.

## Future

- `[ ]` **Plugin System:** Implement a versatile plugin system. Searcher plugins (browsing tmdb?), downloader/streamer plugins (downloading from various trackers?), etc.
  - Very similar to Stremio ([look into it](https://guides.viren070.me/stremio)):
    1. A searcher plugin will allow searching for media that isn't in the local library (e.g. tmdb search plugin)
    2. A downloader/streamer plugin will be required to play any items not in the local library (e.g.: a https stream plugin returning https stream link(s), torrent downloader plugin returning results from a particular tracker). Downloader plugins should also allow one to permanently add a movie/show to the local library. In the spirit of the app, we should make it use an external torrent client (user-configured, similar to existing video player configuration) instead of a built-in one, if possible.
    3. If possible, make Stremio plugins work out of the box with media-browser.
    4. The existing local files searching and playing logic might be refactored into yet another searcher and "streamer" plugin respectively.
- `[ ]` **True Cross-Platform:** TV app? Revive electron thin client?
