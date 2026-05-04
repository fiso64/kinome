

Jojo's Bizarre Adventure

- The server returns completely wrong. Actual:
```
odroid@server:~/storage/MEDIA/MOVIES$ tree JoJo\'s\ Bizarre\ Adventure/
JoJo's Bizarre Adventure/
├── OVA
│   ├── 01. The Evil Spirit (2000).mkv
│   ├── ...
├── Season 01 (Part 01+02) Phantom Blood & Battle Tendency
│   ├── JoJo's Bizarre Adventure (2012) S01E01.mkv
│   ├── ...
│   └── NC
│       └── OP 02.mkv
├── Season 02 (Part 03) - Stardust Crusaders
│   ├── JoJo's Bizarre Adventure (2012) S02E01.mkv
│   ├── ...
│   └── NC
│       ├── ED 01 Last Train Home.mkv
│       ├── ...
├── Season 03 (Part 04) - Diamond is Unbreakable
│   ├── JoJo's Bizarre Adventure (2012) S03E01.mkv
│   ├── ...
│   └── NC
│       ├── ED 01 I Want You.mkv
│       ├── ...
├── Season 04 (Part 05) - Golden Wind
│   ├── JoJo's Bizarre Adventure (2012) S04E01.mkv
│   ├── ...
│   └── NC
│       ├── ED 02 Freek_n You.mkv
│       ├── ...
├── Season 05 (Part 06) - Stone Ocean
│   ├── JoJo's Bizarre Adventure (2012) S05E01.mkv
│   ├── ...
│   └── NC
│       ├── ED 01.mkv
│       ├── ...
└── Thus Spoke Kishibe Rohan
    ├── JoJo's Bizarre Adventure (2012) S00E01.mkv
    ├── ...
```
Response by server after scanning and requesting that folder:
```json
[
  {
    "id": "95ad00fe55bc9076c9244ec54e1bb7c6f1fc8f08cf24fac23b5d7077637657eb",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "OVA",
    "type": "folder",
    "children": [
      {
        "id": "6524a3d8291a27241f505fbedb9317dfd4cd0d4da5f1a1c1432e97af850fb2b5",
        "parentId": "95ad00fe55bc9076c9244ec54e1bb7c6f1fc8f08cf24fac23b5d7077637657eb",
        "name": "[V2] JoJo's Bizarre Adventure (S01-05) (Part 01-06) [BD] [Uncensored] [Dual Audio] [1080p] [HEVC 10bit x265] [AAC] [Eng Sub]",
        "type": "folder"
      },
      {
        "id": "237e9471581038bf5f158fb4fbfc115b2e2bae7b3a0c9fde96af09e547c87ff3",
        "parentId": "95ad00fe55bc9076c9244ec54e1bb7c6f1fc8f08cf24fac23b5d7077637657eb",
        "name": "01. The Evil Spirit (2000).mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "04893b2b3cc774ead4e19a3abe0e1fa6c7743ba35c7a9ebe37e95760d06c7990",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Season 01 (Part 01+02) Phantom Blood & Battle Tendency",
    "type": "folder",
    "children": [
      {
        "id": "0efc4533a2cc111f92d69e50072e743ca721ac912421b66ae4e7d2ba68e5eedc",
        "parentId": "04893b2b3cc774ead4e19a3abe0e1fa6c7743ba35c7a9ebe37e95760d06c7990",
        "name": "NC",
        "type": "folder"
      },
      {
        "id": "01391ac9b89a1544b671a844627963e16d1445af7cc9b8f5d38cad62b061bc12",
        "parentId": "04893b2b3cc774ead4e19a3abe0e1fa6c7743ba35c7a9ebe37e95760d06c7990",
        "name": "JoJo's Bizarre Adventure (2012) S02E01.mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "2b2209f60cfac41c134d3bb7a6717d82485c05b0f7e8bf5b38957f6e6786b82e",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Season 01 (Part 01+02) Phantom Blood & Battle Tendency",
    "type": "folder",
    "children": [
      {
        "id": "9e6e9ba20145182f46007c174971408e559002f5eda8913c0279d7537bb6ddc3",
        "parentId": "2b2209f60cfac41c134d3bb7a6717d82485c05b0f7e8bf5b38957f6e6786b82e",
        "name": "NC",
        "type": "folder"
      },
      {
        "id": "244b5744dcf6f20350d3cbbac47201985fc905e8ccf6232db80a6a39cb982b59",
        "parentId": "2b2209f60cfac41c134d3bb7a6717d82485c05b0f7e8bf5b38957f6e6786b82e",
        "name": "NC",
        "type": "folder"
      },
      {
        "id": "c01ed1fc2c7b26d45c2d8d636aff1d0a5a213c5b3502f4f567606d67aeea1dc5",
        "parentId": "2b2209f60cfac41c134d3bb7a6717d82485c05b0f7e8bf5b38957f6e6786b82e",
        "name": "JoJo's Bizarre Adventure (2012) S01E01.mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "c5c7f6bf7dd420a9029cf176575d4ec4b981bd0696f2f243107e484d2e7fb4d1",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Season 02 (Part 03) - Stardust Crusaders",
    "type": "folder",
    "children": [
      {
        "id": "cf84f9868e6844e369eb576932a3762d81aa08446af3d3f73b74fab17a81737f",
        "parentId": "c5c7f6bf7dd420a9029cf176575d4ec4b981bd0696f2f243107e484d2e7fb4d1",
        "name": "NC",
        "type": "folder"
      },
      {
        "id": "498695ac1ce04963e53c9bd11aac535cb738c55edee71350c69dbc609c1b7f46",
        "parentId": "c5c7f6bf7dd420a9029cf176575d4ec4b981bd0696f2f243107e484d2e7fb4d1",
        "name": "JoJo's Bizarre Adventure (2012) S03E01.mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "ae28dfb6d13ddbb1486bbf8519a7893c9b5866d6a553e18a5de0a9efa5d3b5e4",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Season 03 (Part 04) - Diamond is Unbreakable",
    "type": "folder",
    "children": [
      {
        "id": "6da79e0ab1b9b331bc3f0cccfa573f3feef1a831cf7b20a39ef67c20acac23f9",
        "parentId": "ae28dfb6d13ddbb1486bbf8519a7893c9b5866d6a553e18a5de0a9efa5d3b5e4",
        "name": "OVA",
        "type": "folder"
      },
      {
        "id": "cacbc803161e7b057325684173219e9c99a1a711f9d16d7c15b7c8d54e819498",
        "parentId": "ae28dfb6d13ddbb1486bbf8519a7893c9b5866d6a553e18a5de0a9efa5d3b5e4",
        "name": "JoJo's Bizarre Adventure (2012) S04E01.mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "feba77d8009b79e6059fa37d32c42c81408c13d9e45843044d9f5f2726017f23",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Season 04 (Part 05) - Golden Wind",
    "type": "folder",
    "children": [
      {
        "id": "f154701e462e09d529794185beeb675c5add4e50513955573b7a2b6ce7ec2864",
        "parentId": "feba77d8009b79e6059fa37d32c42c81408c13d9e45843044d9f5f2726017f23",
        "name": "NC",
        "type": "folder"
      },
      {
        "id": "97ae128e9065ac48cf41793fd2d9a0dd2c952101047cc4d354c12eacf8aa6b01",
        "parentId": "feba77d8009b79e6059fa37d32c42c81408c13d9e45843044d9f5f2726017f23",
        "name": "Season 05 (Part 06) - Stone Ocean",
        "type": "folder"
      },
      {
        "id": "fe8ce9da20ceec5ac7ae212ccd8bee78ec8d52687fa8f92f5fde81bc1dda9690",
        "parentId": "feba77d8009b79e6059fa37d32c42c81408c13d9e45843044d9f5f2726017f23",
        "name": "JoJo's Bizarre Adventure (2012) S05E01.mkv",
        "type": "file"
      }
      // ...
    ]
  },
  {
    "id": "0a921a7baa4d75be58c7bdd6036ac312fab224d2b835605bf5bd238aa8d684e6",
    "parentId": "d2b39f8097fd9e2c7bf78df522208fa74a30ef96fcd45a1a1a41fa1a0244a0b2",
    "name": "Thus Spoke Kishibe Rohan",
    "type": "folder",
    "children": [
      {
        "id": "8c7c3d2472a5d08f85be5fd3522924e3a3242d56b404a3f78f5fc5b762431650",
        "parentId": "0a921a7baa4d75be58c7bdd6036ac312fab224d2b835605bf5bd238aa8d684e6",
        "name": "JoJo's Bizarre Adventure (2012) S00E01.mkv",
        "type": "file"
      }
      // ...
    ]
  }
]

```
Incorrect nesting, duplicated folders, etc. Completely fucked up.

- Find out why season assignment assigns Season 1 to `OVA` folder even though there are folders containing high confidence patterns `Season XX`. 
- Also add special case for `OVA` folder

---

On my windows desktop, first time mpv is launched for any video file, it exits. Need to launch a second time.
(Check mpv logs first)

---

Page reload became slow for no reason.

---

Add tests proving that the metadata clear action does not delete the folder settings retrieve_children_metadata, children_type_hint, and process_tv_children.
Add a test asserting that the scanner does not automatically assign season or episode numbers if process_tv_children is disabled (check first; maybe this test already exists).

---

Bug: File properties window always says "This item does not have a physical path on the disk (e.g., virtual item)." for real files.

---

UX issue. Starting from home:

1. Type in search bar
2. Press browser back
Correctly navigates back to home view (good). 

However if you instead
1. Type in search bar
2. Navigate to any result
3. Navigate back to the search view
4. Try to navigate back again
Then nothing happens. Need to press escape to close the search view and get back home.

Similarly, from home view:
1. Navigate into any item detail view (movie or show)
2. Click on of its genre pills, which will go to the search view
3. Try to navigate back
It will not navigate back to the item detail view.

---

More retriever metadata. Fetch many more important TMDB fields like whether the show is airing, PG rating (if that's a thing), ratings, links, studios and other production info, etc, etc.
Add them as new fields to virtual tag/virtual folder configurations and search bar, where applicable.

---

New global setting: Refetch remote metadata on file change. On rescan, if playable files are updated, mark as stale the closest tv show or movie type parent (including intermediate season types if any) for the metadata fetch phase, resulting in a refetch. Useful for airing tv shows. On by default.

---

More local metadata. Use ffmpeg to extract lots of data from all playable files in the library such as the duration, encoder, audio, resolution, subtitle and audio tracks (and their properties), etc, etc.
Add useful ones as new fields to vtag/vfolder configurations and the search bar.

Need careful thought how to make this fast but also not too intensive on low powered devices. Maybe a global setting controlling the number of concurrent ffmpeg jobs?

Also need to think when and how that data needs to be invalidated and refetched. For example, a downloading torrent file might initially have incomplete/broken headers which would result in bad output from ffmpeg or a crash. We don't want to commit this forever.

---

Add new sort by: last watched date and add new home section "Last Watched".
Also add new fields for vtags and vfolders: days since last watched (int), and playback state ∈ {completed, unwatched, in progress}, where
- completed = media type = movie and (item type = file and item watched = true OR item type = folder and item has playable child item which is watched) OR media type = tv and all episodes are watched.
- unwatched = nothing watched at all for that item
- in progress = Not unwatched and the last episode of the last season is not watched. Invariant: Only tv shows can have in progress playback state.

---

Fix sorting of folders before files even when both have a media type tv or movie. E.g. If both a file and folder have media type movie, then they should both be sorted alphabetically together.

---

Make it possible to apply non-cascadable view-related settings to children automatically (grouping).
(This needs more thought.)

---

Make the UI more clear regarding child view overrides / normal view settings and refactor the code if needed.

---

Find any places where we use json stringify (or similar) to deep compare items and replace by fast deep equal, which is already used in some places throughout the code.
Ensure that individual settings fields are not saved to files if they have not been modified by the user (sparse). Only modified fields are written to json.

---

vtags should not be bound to media entities, they should be bound to files and folders (maybe?):

- Rename/migrate entity_virtual_tags → item_virtual_tags (or add an item_id column)
- Change evaluateAndInsertVirtualTags to insert by i.id, drop the entity_id IS NOT NULL guard
- Update all JOINs from ON i.entity_id = vt.entity_id to ON i.id = vt.item_id
- Update clearVirtualTags accordingly

We will also add a new vtag config option which makes them only apply items with non null entity id. This should be exposed as a checkbox for each vtag in the UI and enabled by default.

---

Layout system design (small refactor)
```
While adding the `button-grid` layout, I noticed a few significant architectural bottlenecks and DRY (Don't Repeat Yourself) violations. The layout system works, but it's suffering from **"Prop Drilling and State Explosion"**, which makes scaling it painful.

Here are the main areas of tech debt I noticed:

### 1. The "State Explosion" in Settings Modals
To add `scrollHorizontally`, I had to explicitly declare it, bind it, and track it in:
- `ItemSettingsModal.svelte` (as a `$state`, in the `hasChanged` checks, and in the payload builder)
- `ViewTab.svelte` (as a prop and binding)
- `ViewConfigurator.svelte` (as a prop and binding)
- `DefaultLayoutSettingsModal.svelte` (as a `$state`, and in two separate `$effect` sync blocks)

**The Problem:** The UI treats every layout-specific setting as a top-level, independent variable. If we add 5 more layout types with 10 new settings, the boilerplate in these 4-5 files will grow linearly and become a nightmare to maintain.
**The Fix:** The UI should treat layout-specific settings dynamically. Instead of `bind:gridPosterSize`, the components should just pass around a `layoutSettings: Record<string, any>` dictionary and use `LAYOUT_SPECIFIC_SETTINGS_CONFIG` to dynamically render inputs and detect changes.

### 2. Duplicated UI Logic for Horizontal Scrolling
Take a look at `HorizontalGridView.svelte` and `ButtonGridView.svelte`. They both duplicate about 100 lines of identical code for:
- The persistent scroll state (`viewStateStore`).
- The scroll button SVGs and visibility logic (`canScrollLeft`, `canScrollRight`).
- The fade gradients (`::before` / `::after` CSS).
- The `horizontalScroller` action binding.

**The Problem:** If we want to change the style of the scroll buttons, or fix a bug with persistent scrolling, we have to do it in multiple files.
**The Fix:** We should extract this into a `<HorizontalScrollContainer>` wrapper component that handles the buttons, gradients, and store logic, accepting the grid items via a Svelte snippet or slot.

### 3. Flat Type Definitions
In `types.ts`, `StoredViewSettings` is a massive intersection of all possible layout settings (`GridSettings & HorizontalGridSettings & ListSettings...`). 

**The Problem:** There is no strict type relationship enforcing that `gridPosterSize` only belongs to grid-like layouts. At the data layer, it's just a giant bucket of optional properties.
```
Are these issues still accurate? Check. 

---

# Manual episode assignment
We currently have: tv show, movie, and season-level manual assignment flows, but not episode-level assignment.
Example: I have a special episode in the S02 folder (Black Mirror S02EXX.Special.White.Christmas.mkv). Tmdb thinks it's part of season 0 (Specials). I cannot link this episode to the metadata from the special season because the episode is in the S02 folder. Want to achieve this without having to move the file (tmdb isn't God, users may prefer to organize differently).
Easy solution: Edit the episode metadata to set the season to 0 and the episode number to 1. Currently does not seem to work (bug?). Doesn't put the episode in the specials tab or fetch metadata for it. 
However, even if we have that, maybe I want to still keep the episode in the S02 tab. Need to think of a clean way to handle this - some kind of override? 