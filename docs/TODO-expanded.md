
# Manual episode assignment
We currently have: tv show, movie, and season-level manual assignment flows, but not episode-level assignment.
Example: I have a special episode in the S02 folder (Black Mirror S02EXX.Special.White.Christmas.mkv). Tmdb thinks it's part of season 0 (Specials). I cannot link this episode to the metadata from the special season because the episode is in the S02 folder. Want to achieve this without having to move the file (tmdb isn't God, users may prefer to organize differently).
Easy solution: Edit the episode metadata to set the season to 0 and the episode number to 1. Currently does not seem to work (bug?). Doesn't put the episode in the specials tab or fetch metadata for it. 
However, even if we have that, maybe I want to still keep the episode in the S02 tab. Need to think of a clean way to handle this - some kind of override? 


# Move sorting logic to backend
title.