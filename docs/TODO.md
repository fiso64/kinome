Add new sort by: last watched date and add new home section "Last Watched" after "Recently Added".
Also add new fields for vtags and vfolders: days since last watched (int), and playback state ∈ {completed, unwatched, in progress}, where
- completed = media type = movie and (item type = file and item watched = true OR item type = folder and item has playable child item which is watched) OR media type = tv and all episodes are watched.
- unwatched = nothing watched at all for that item
- in progress = Not unwatched and the last episode of the last season is not watched. Invariant: Only tv shows can have in progress playback state.

Be careful with performance.

---

Fix sorting of folders before files even when both have a media type tv or movie. E.g. If both a file and folder have media type movie, then they should both be sorted alphabetically together.

---

Make it possible to apply non-cascadable view-related settings to children automatically (grouping).
(This needs more thought.)

---

Make the UI more clear regarding child view overrides / normal view settings and refactor the code if needed.

---

We currently have: tv show, movie, and season-level manual assignment flows, but not episode-level assignment.
Example: I have a special episode in the S02 folder (Black Mirror S02EXX.Special.White.Christmas.mkv). Tmdb thinks it's part of season 0 (Specials). I cannot link this episode to the metadata from the special season because the episode is in the S02 folder. Want to achieve this without having to move the file (tmdb isn't God, users may prefer to organize differently).
Easy solution: Edit the episode metadata to set the season to 0 and the episode number to 1. Currently does not seem to work (bug?). Doesn't put the episode in the specials tab or fetch metadata for it. 
However, even if we have that, maybe I want to still keep the episode in the S02 tab. Need to think of a clean way to handle this - some kind of override?
