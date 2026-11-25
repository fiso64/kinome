# Jellyfin-compatible API proposal

**Status:** implemented in `src/main/jellyfin/`. Jellyfin's web client works against it end to end. Android TV, Wholphin, Moonfin, Seerr, Sonarr and Radarr are implemented from their source code but not yet run against Kinome. Favourites, Quick Connect, trickplay and scaled artwork are implemented. See [Implementation notes](#implementation-notes).

## Using it

- **Server address:** `http://<host>:<port>/jellyfin` in any Jellyfin client. Sign in with a Kinome account.
- **Jellyfin's web client** is served at `/jellyfin/web`, vendored unmodified in `vendor/jellyfin-web` from the pinned release. The official Android and iOS apps open it from the server. Its dashboard, plugin and Live TV pages show Kinome's empty answers. Update it with `bun scripts/jellyfin-web.ts` after changing the release pinned in `src/main/jellyfin/web.ts`.
- **Seerr:** choose Jellyfin, enter the same address, and sign in with an administrator account. Seerr creates its own API key.
- **Quick Connect:** a Jellyfin app that shows a six-digit code can be approved under *Your Account → Quick Connect* in Kinome, or from another signed-in Jellyfin app.
- **Libraries, collections and playlists:** tag a Kinome virtual folder `jellyfin:movies` or `jellyfin:tvshows` to make it a library, `jellyfin:collection` for a collection, or `jellyfin:playlist` for a playlist. A personal tag does this for your account only. Once any folder is a library, the two default libraries give way to the tagged ones. A playlist follows its folder's sort and arrangement. If its filter is a single tag condition, such as `playlist = road trip`, apps can add, remove and move items, which sets or clears that tag and arranges the folder, and needs the right to edit metadata.
- **Versions and extras:** files in a movie folder that are at least 70% as long as the longest are versions of the film, picked in apps' version menus. Shorter files, and files in subfolders such as `Extras`, are extras, typed by name: `trailer`, `deleted`, `making of`, `interview` and so on.
- **Sonarr and Radarr:** add an Emby / Jellyfin connection with the same host, port and base path, and an API key created under *Your Account → API Keys* in Kinome. Use an administrator's key, because library updates need the scan permission. Disable *Send Notifications*.

Add a second HTTP surface that speaks enough of Jellyfin's API for native clients and common integrations to treat Kinome as a Jellyfin server. It is a translation layer over Kinome's existing services, mounted under its own prefix. Kinome's own API, web UI and data model stay as they are.

The main payoff is playback on devices. Native Jellyfin clients bring their own players (ExoPlayer, mpv, AVPlayer), direct-play Matroska and most codecs, and are unaffected by browser codec and autoplay behaviour. TV apps and request/automation tools come with it.

## Acceptance targets

In order. Each one is a milestone that ships alone.

1. **Jellyfin's web client**, pointed at Kinome. It can be driven in headless Chromium, so it is the automated conformance check.
2. **Jellyfin for Android TV** (the official client).
3. **Wholphin** and **Moonfin** on TV.
4. **Seerr, Sonarr, Radarr.**

Out of scope: Live TV, SyncPlay, plugins, DLNA, the admin dashboard, scheduled tasks, backups, music, books, photos. Clients must see these as absent or disabled, not as errors.

## What was examined

- Jellyfin's published stable OpenAPI document, which reports version 12.4.0: 294 paths, 364 operations, 357 schemas. A third of the operations belong to areas that are out of scope (Live TV 38, SyncPlay 22, plugins 17, and so on).
- Source of the three TV clients at their heads on 2026-11-23 to 25, counting distinct API calls:
  - Android TV makes about 68 distinct calls. Roughly 25 are Live TV, music, lyrics or playlists.
  - Wholphin makes about 97. That count includes calls to Seerr's own API, which Wholphin talks to directly.
  - Moonfin is one Flutter codebase for several server types. Its extras (requests, watch parties, ratings rows, poster badges, settings sync) come from a companion server plugin called Moonbase. Plain Jellyfin browsing and playback do not need it.
- Kinome's schema, auth service and playback services.

Nothing here has been run against a real client. Client behaviour beyond the calls they make is inferred.

## Size

| Slice | Jellyfin surface | Kinome side |
| --- | --- | --- |
| Connect and sign in | Public system info, authenticate by name, current user, user policy and configuration, branding, sessions capabilities, display preferences | Accounts and roles exist. Persistent tokens and a server ID do not. |
| Browse | User views, `/Items` (88 query parameters), single item, latest, resume, next up, seasons, episodes, similar, genres, people, search hints, images | Items, entities, credits, genres, FTS, continue watching and next up exist. |
| Play | Playback info with a device profile, direct stream, transcode stream, subtitles, attachments | Range streaming, on-demand HLS, probe data, subtitle and font extraction exist. |
| Track | Playback start, progress, stopped, played and unplayed, user data | Position and watched exist. Favourites and play counts do not. |
| Integrate | Library media updated, media folders, users list, API keys | Scoped rescan exists. API keys do not. |

A browse-and-direct-play slice for the web client is on the order of 30 operations. All four targets together are on the order of 80 to 100, plus behaviour that only shows up when a real client runs.

## Design

- **One adapter module, no second model.** `src/main/jellyfin/` holds routes and mappers. Every handler calls existing services. It owns one table, for clients' opaque display preferences (decision 8). Everything else it needs is added to Kinome itself.
- **Own prefix.** Mounted at `/jellyfin`. Jellyfin supports a base path, so clients accept `http://host:port/jellyfin` as the server address. Nothing is added to `/api`.
- **Types from the spec.** Generate TypeScript types for the request and response shapes from the OpenAPI document and pin the document's version in the repo. Implement from the spec, not from Jellyfin's server code: Jellyfin is GPL-2 and Kinome is AGPL-3.
- **Visibility is enforced at the adapter boundary.** Every query goes through the same account visibility that `/api` uses. No handler reads items without an account.
- **Unknown stays quiet.** Unsupported list endpoints return empty results and unsupported features are reported as disabled in the user policy, so clients hide them.
- **`/Items` is the hot path.** It must be one paginated SQL query through the existing query builder, honouring `startIndex` and `limit`, with no JSON columns in filters. Clients call it for every row on a home screen.

## Rules for the implementation

These hold for every change. A change that cannot meet one stops and raises it instead of working around it.

**Structure**
- One slice per change, in the [order of work](#order-of-work). Each ends with the web-client check passing.
- All adapter code lives in `src/main/jellyfin/`. Nothing is added to `/api` and no existing route changes shape.
- The adapter creates one table, for display preferences. Anything else it needs is a change to Kinome itself, made and reviewed as its own change first.
- Handlers call existing services. They do not query the database directly and do not duplicate service logic.

**Access**
- Every handler that returns or acts on items takes an account and goes through the same visibility filter as `/api`. There is no unauthenticated item read and no "admin view" shortcut.
- A test signs in as a restricted account and asserts that a hidden item is absent from `/Items`, single-item, search, images, playback info and stream responses.
- Tokens and API keys are stored hashed. Changing a password or role, or deleting an account, revokes that account's tokens.
- An API key carries an account and has that account's permissions and no more.

**Performance**
- `/Items` issues a bounded number of SQL statements per request, independent of the number of items returned. Paging happens in SQL. No filtering or sorting of the full result in memory.
- No JSON columns in filters, sorts or joins.
- Listing responses do not probe files, read images or call TMDB.
- Each listing endpoint has a check against a library of realistic size before it is considered done.

**Correctness**
- Every response validates against the pinned OpenAPI document in the test suite.
- Unsupported features return an empty result or are disabled in the user policy. They never return fabricated data.
- IDs, provider IDs and filesystem paths pass through unchanged apart from the documented ID presentation. Display normalisation stays out of stored values.
- A fix for one client's behaviour comes with a note of which client and version needed it. If a mapping is wrong, fix the mapping. Do not add a per-client special case for it.

**Review points**
- Persistent sign-ins and API keys, before anything is built on them.
- The `/Items` query, before other listing endpoints reuse it.
- Playback negotiation from device profiles, before it is used by a TV client.

## Mapping

| Jellyfin | Kinome | Notes |
| --- | --- | --- |
| Item `Id` (UUID) | `media_items.id` | See decision 1. |
| `Movie`, `Series`, `Season`, `Episode` | Item with an entity of type `movie`, `tv`, `season`, `episode` | Virtual season items map to `Season`. |
| `Folder`, `Video` | Folder or file without a matched entity | Not exposed at first. Needed only if a "Folders" library is added. |
| `CollectionFolder` (a library) | Two synthetic libraries: Movies and TV Shows | Decision 2. |
| `BoxSet` (a collection) | User virtual folder | Candidate mapping, read-only. |
| `MediaSources` (versions of one title) | `media_locations` of one item | Kinome's multiple locations become selectable versions. |
| `MediaStreams` | `local_media_tracks` | Already probed and stored. |
| `ProviderIds` | TMDB ID and IMDb ID | No TVDB ID is stored. |
| `UserData.Played`, `PlaybackPositionTicks`, `LastPlayedDate` | `user_state` | Ticks are 100 ns: seconds × 10,000,000. |
| `UserData.IsFavorite`, `PlayCount` | None | See decision 4. |
| Resume, Next Up | Continue watching and next up, including dismissals | |
| People and genres as items | `people`, `genres` | IDs derived from TMDB person ID and genre name. |
| `CommunityRating`, `OfficialRating`, `PremiereDate`, `DateCreated` | TMDB rating, content rating, release date, `first_seen_at` | |
| Images by type and requested size | Cached poster, backdrop and logo files | See decision 5. |
| User, `Policy` | Account, role and capabilities | Admin maps to `IsAdministrator`. |

## Playback

- `POST /Items/{id}/PlaybackInfo` receives the client's device profile and returns media sources. Each source says whether it can be direct-played, direct-streamed or transcoded, and for a transcode carries a ready-made `TranscodingUrl`.
- Clients fetch that URL as given. Kinome can therefore return its existing HLS URL shape and does not need to reproduce Jellyfin's own stream URL parameters. The 12.4 document lists no HLS playlist routes at all, which fits this, but it needs confirming against each client.
- Direct play maps to the existing range stream. Native clients will use it for most files.
- Kinome chooses conversions by picture height. Jellyfin clients ask by maximum bitrate. The adapter needs a bitrate-to-rendition rule.
- Subtitles map to the existing extraction endpoints for text, ASS and image formats. Burning subtitles into the picture is not something Kinome does. The adapter reports external and embedded delivery only.
- Playback start, progress and stopped reports map to the existing position and watched logic. This also delivers the plan item "use playback progress to track watched state in external players" for these clients.

## Decisions

1. **Item IDs. Agreed, provided the lookup stays fast.** Jellyfin IDs are UUIDs and the Kotlin SDK parses them strictly. Kinome item IDs are a mix of UUIDs and 64-character hashes. UUID-shaped IDs pass through, and a hash ID is presented as its first 32 hex characters. The reverse lookup is a primary-key range scan on that prefix, so no mapping table is needed. Account IDs such as `admin` need the same treatment with a small in-memory map.
2. **What a "library" is. Agreed: two standard libraries, Movies and TV Shows.** Jellyfin clients and Seerr expect a few typed libraries. Kinome is folder-first with free nesting, virtual folders and groupings. The adapter presents two synthetic libraries built from matched entities, flattening the folder tree. Unmatched files, the operator's folder structure and virtual folders are not shown in these clients at first. Two additions stay possible later without changing this: a "Folders" library that browses Kinome's tree, and libraries that follow Kinome's home categories.
3. **Persistent sign-ins and API keys. Agreed as a prerequisite.** Kinome sessions live in memory and are lost on restart. A TV app stores its token once and expects it to keep working. Seerr and the arrs authenticate with a long-lived API key. Both need a persisted token table in Kinome itself, which also keeps the web UI signed in across restarts.
4. **Favourites. Agreed: a personal `favorite:true` tag.** Every client has a favourite button and favourites rows. Kinome's tags are shared by all accounts today, so personal tags ([plan entry](Plan.md)) come first as a prerequisite. A favourite is then that tag and nothing else. The lookup must be indexed by account, because clients ask for it on every item and filter by it. Implemented: personal tags are stored per account in `account_item_tags` and edited under *Personal tags* in an item's settings, which every account may change for itself. Play counts have no Kinome equivalent and are reported as 0 or 1 from the watched flag.
5. **Image sizes. Implemented: scaled copies.** A request with a width gets a copy scaled with FFmpeg to the next of a few fixed widths, never larger than the stored file, cached under the library's `cache/images`. Without FFmpeg the stored file is served.
6. **Which Jellyfin version to present. Agreed: the latest stable, pinned to the spec the types are generated from.** Clients only refuse servers below their minimum, so the latest satisfies all of them. Android TV pins SDK 1.8.12 and names 10.11 as an upcoming minimum. Wholphin pins SDK 1.9.4 and names 12.0. The stable document is 12.4. Separately, a client on an older SDK may call routes that the 12.4 document no longer lists. Those are added where a target client needs them, found from its pinned SDK.
7. **Paths from the arrs. Agreed.** Sonarr and Radarr report changed paths as they see them. If they run in containers those paths differ from Kinome's. The update endpoint maps paths where it can and otherwise falls back to a scoped rescan of the matching source.
8. **Client display preferences. Agreed: store them.** Clients save some of their own settings on the server so they follow the user across devices. Android TV keeps per-library view choices there (poster size, image type, grid direction, sort field and order, favourites-only and unwatched-only filters) and some per-user settings such as skip lengths. Kinome stores each one as an opaque blob keyed by account, client name and the client's own ID, and returns it unchanged. It never interprets the contents. This is the one table the adapter owns.

## Testing

Jellyfin's own API tests cannot be reused. They are C# tests that start Jellyfin in-process against an empty library and mostly assert status codes for missing items. They cannot be pointed at another server. What can be used instead:

- **Schema conformance.** Validate every response the adapter produces against the pinned OpenAPI document in the normal test suite. This catches wrong field names, types and missing required fields cheaply.
- **Jellyfin's generated TypeScript SDK as the test client.** Tests call Kinome through the same client code that real apps are built on.
- **The web client end to end** in headless Chromium: sign in, browse, open a title, play, seek, resume.
- **Differential checks against a real Jellyfin** scanning the same small library, for the endpoints where behaviour matters more than shape. Run on demand, not in the normal suite.
- **Real TV clients by hand**, for what only they reveal. The Kotlin SDK's strict parsing is the main thing the checks above cannot fully cover.

## Risks

- **Behaviour is not in the spec.** Field presence, ordering, casing and which optional fields a client dereferences are learned by running clients. The web client catches much of this automatically. TV clients need a person with the device.
- **Moving target.** Clients update with Jellyfin. Pinning the spec version and re-running the web client check on each bump keeps this visible.
- **Episode numbering.** Kinome stores fractional episode numbers. Jellyfin's index is an integer.
- **WebSocket.** Clients open a socket for server events and remote control. The adapter should accept it and keep it alive without implementing remote control, or clients may retry in a loop.

## Implementation notes

What the implementation settled that the plan above did not:

- **JSON casing.** Jellyfin answers in PascalCase unless the first JSON form in the Accept header names the CamelCase profile, and in camelCase when there is no Accept header. Jellyfin's own SDK lists several forms, so matching on any mention of CamelCase broke it.
- **Images without a token.** Browsers and image loaders fetch artwork without the access token. An image tag is an HMAC of the image's path and version with a per-server secret, so a request carrying the current tag is served without a token. A request without a valid tag needs a signed-in account and its visibility applies.
- **Sonarr and Radarr report paths Kinome gave them.** They look an item up by provider ID, read its `Path` (shown to administrators only), and send the same path back after a change. Kinome scans that path, its folder if it is gone, and the whole library only if the path is outside the media sources. Container path mappings in the arrs therefore do not matter.
- **Seerr reads its new API key back from the key list.** Keys are stored hashed, so a key created through `/Auth/Keys` stays readable to its account in memory for five minutes, then only its name and dates are listed.
- **Server identity.** `server-identity.json` in the data directory holds the public server ID and the secret that signs image tags.
- **Played state lives on files.** Kinome records watched and position on the file that played, never on a movie folder. A movie reports, filters and resumes through its feature file, chosen by the same rule as Kinome's detail view. A title's one media source carries the title's ID, as in Jellyfin, because clients look a source up as an item. Played filters on series are not applied.
- **Search** asks Kinome's search service for up to 200 ranked matches, then pages them in rank order.
- **Filtering by media type uses `media_items.media_kind`.** It is the effective media type, kept by triggers and indexed. Filtering on the metadata view instead made every listing scan the whole library.
- **Genre filters are relational.** Item genre overrides are mirrored by triggers from `media_item_metadata.genres_json` into `item_genres`, and every genre filter in Kinome, including search and suggestions, reads that table and `entity_genres`. JSON is parsed only when an override is written.
- **Quick Connect** keeps waiting devices in memory for ten minutes. A wrong code counts against the approving account like a failed sign-in.
- **Trickplay** sheets of 10 × 10 thumbnails, ten seconds apart, are made on first request from keyframes only, in about a second per sheet, and cached under the library's `cache/trickplay` until the file changes.
- **Benchmark.** `bun scripts/jellyfin-benchmark.ts` times the listing routes on a synthetic library of 5,000 movies and 300 series with 18,000 episodes, and counts statements. On 2026-11-25 every route used at most eight statements. Movie pages took about 45 ms, the series page 40 ms and everything else under 20 ms. Most of the remaining time is Kinome's item read model sorting and counting the matching rows.
- **Spec.** `bun scripts/jellyfin-openapi.ts [spec URL or file]` refreshes `openapi.json` and `openapi.d.ts` from Jellyfin's document, keeping the operations the adapter routes. Tests validate responses against it, rejecting unknown fields.

- **Chapters** are read by the same cached probe the web player uses, on item details only, because the library stores none. The first view of an item probes its file, in about 40 ms.
- **Server events** are collected for a second and sent once per account: `LibraryChanged` with the titles that account can see, and `UserDataChanged` with its own played, progress and favourite changes. A batch lists at most 500 items. Kinome's own player does not report progress to the socket, only played changes.
- **Tagged folders** are found with one indexed lookup over shared and personal `jellyfin` tags per request. Seasons and episodes in a TV library folder belong to it through their series, whose IDs are found first.
- **Playlist moves** keep items arranged after the moved item with it.

## Order of work

1. Prerequisite in Kinome itself: persistent sign-ins and API keys. Personal tags can follow later, since favourites degrade to false without them.
2. Connect, sign in, browse and direct play, verified with the web client in headless Chromium.
3. Progress, watched state, resume and next up.
4. Android TV, then Wholphin and Moonfin, fixing what only real clients reveal.
5. Transcode negotiation from device profiles.
6. Seerr, then the arrs.
