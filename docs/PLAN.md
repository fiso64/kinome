
### Stuff

*   `[ ]` Clean up the API and optimize. Currently sends huge amount of data even though most of it is frequently not needed. Should be smarter and much more on-demand. Must rethink from scratch and adopt a good pattern.
*   `[ ]` Option to rescan on startup or watch for changes => Need to ensure rescan is non-destructive, always.
*   `[ ]` More UI configuration: Sorting and filtering any view by anything (metadata, tags, virtual tags).
*   `[ ]` Improve navigation and user action performance as much as possible. Remove all lag and jitter.
*   `[ ]` Optional: Refine player support. More detailed watched states (including time) => integration with common video players like mpv, vlc. (Maybe later)
*   `[ ]` Improve and polish UI everywhere. Test on different screen sizes.
*   `[ ]` Multi account support.

#### Future

*   `[ ]` **Plugin System:** Implement a versatile plugin system. Searcher plugins (browsing tmdb?), downloader/streamer plugins (downloading from various trackers?), etc.
    *   Very similar to Stremio ([look into it](https://guides.viren070.me/stremio)): 
        1. A searcher plugin will allow searching for media that isn't in the local library (e.g. tmdb search plugin)
        2. A downloader/streamer plugin will be required to play any items not in the local library (e.g.: a https stream plugin returning https stream link(s), torrent downloader plugin returning results from a particular tracker). Downloader plugins should also allow one to permanently add a movie/show to the local library. In the spirit of the app, we should make it use an external torrent client (user-configured, similar to existing video player configuration) instead of a built-in one, if possible.
        3. If possible, make Stremio plugins work out of the box with media-browser.
        4. The existing local files searching and playing logic might be refactored into yet another searcher and "streamer" plugin respectively.
*   `[ ]` **True Cross-Platform:** Web? Android? iOS?
