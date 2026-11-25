# Vendored software

## jellyfin-web

`jellyfin-web/` is the built web client of [Jellyfin](https://jellyfin.org), unmodified, taken from the
release archive pinned in `src/main/jellyfin/web.ts` by `scripts/jellyfin-web.ts`. Kinome serves it at
`/jellyfin/web` for Jellyfin apps that open the server's own web client.

It is licensed under the GNU General Public License, version 2 or later. Its source is at
<https://github.com/jellyfin/jellyfin-web>, under the tag matching the pinned release (`v12.4`).
Bundled third-party notices are in the `*.LICENSE.txt` files beside the scripts they cover.
