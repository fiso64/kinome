

Bug: File properties window says "This item does not have a physical path on the disk (e.g., virtual item)." for real files.

---

Random sort re-sorts too often (every children fetch)

- Page refresh (this is acceptable, maybe even good)
- When I edit metadata of an item in home view
- During scans when home view is refreshed periodically

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
 
Right now, home is defined as:
Scope: Full Library
Conditions: Parent retrieve children metadata = 1 OR media type = movie OR media type = tv

For better decoupling, let's create a predefined virtual tag "_is_in_home" with the same definition as the conditions above. This vtag should be visible in the virtual tag settings screen among the others and be fully editable, but not deletable and the name should not be editable. Also, it should not have editable values (similar to how vtag definitions appear in the vfolder settings), because it is boolean-valued.

The home folder should then use this predefined virtual tag by default, i.e. the new condition should be:
vt: _is_in_home = 1. 

Then, remove the dropdown option for scope: home folder, as this is now done easily with scope: full library and condition: _is_in_home = 1.

Please refactor this cleanly, keeping in mind that we will add further predefined virtual tags in the future (some might not be boolean-only or non-deletable, though).

P.S: 

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

---

Implement account support. For now, only differentiate between admin and non-admin users. 
- Admin: Can do everything.
- Non-admin: Can ONLY watch items.
- The only per-user data for now will be the watched state of items, the password, and whether a password is required.
- Admins should have the ability to restrict a particular account to a virtual tag.


# Manual episode assignment
We currently have: tv show, movie, and season-level manual assignment flows, but not episode-level assignment.
Example: I have a special episode in the S02 folder (Black Mirror S02EXX.Special.White.Christmas.mkv). Tmdb thinks it's part of season 0 (Specials). I cannot link this episode to the metadata from the special season because the episode is in the S02 folder. Want to achieve this without having to move the file (tmdb isn't God, users may prefer to organize differently).
Easy solution: Edit the episode metadata to set the season to 0 and the episode number to 1. Currently does not seem to work (bug?). Doesn't put the episode in the specials tab or fetch metadata for it. 
However, even if we have that, maybe I want to still keep the episode in the S02 tab. Need to think of a clean way to handle this - some kind of override? 


# Move sorting logic to backend
title.