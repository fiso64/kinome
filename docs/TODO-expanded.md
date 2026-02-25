
# Next steps
0. Database. See docs/database-refactoring-analysis.md.

1. Implement "New virtual folder" feature. In any folder, I can create a new persistent virtual folder which has
    - Its own settings, metadata, etc (should be near-equivalent to a real folder at repo layer)
    - Can define which object pool it uses (e.g. current parent folder, or all movies+tv shows). This should be implemented as a boolean-valued virtual tag (the vtag system might have to be extended a bit).
        - Everything must be done in db for performance.
    - Example: Recently added section.
        - For this, we must also implement sorting (to sort by date added, for example).
    - Can be sorted into the current view by user preference. If I have set my view to show sections, I want to be able to set my custom virtual folder "Recently Added" to appear as the first one.
    - Rethink the home view. Instead of hardcoding it to root folder, we'll introduce a special built-in "home" virtual folder. To mimick other media servers, we'll set its default contents to be all movies+tv shows in the library. Current behavior would be covered by setting it to show all direct children of root dir (with and without metadata).
        - Home will be a different url instead of /?folder=root. /?folder=root should no longer have any specific modifications like the continue watching section; instead, it should be treated like any other folder. In home view, we display our special logic (e.g. continue watching with the nice background, etc.), and then append the contents of the special home virtual folder.
    - New framework idea: There will no longer be any "transient" virtual folders created during grouping (or rather, the only such virtual folder will be the "Files" one which is used for loose children when displaying as tabs or sections). Everything else will be implemented as true virtual folders.
        - For any loose children episodes, we will create a virtual season folder for them (during scan).
        - The grouping logic will become significantly simpler. Essentially, we will always group by "Folder". When user chooses a different grouping via ui, internally the backend will modify that folder to have children virtual folders for each group. => Grouping is no longer a view setting, because now grouping controls the true virtual folder structure. In order to easily switch between different groupings, these virtual folders should carry a special flag, so that we can delete them and rebuild with a new grouping when the user changes their preference. However, for all intents and purposes, these folders will be indistinguishable from real subfolders. Therefore the grouping logic will be refactored to a service that modifies the children of a folder, and the children endpoint will not create any groups at runtime, but rather just return the children of the folder (virtual or not, and recursive if needed depending on layout setting, and possibly adding the "Files" transient group).
        - Grouping will no longer be a view setting and it will no longer be only available for sections or tabs layouts. It will be a property of the folder (or more accurately, an action that can be performed on a folder). The layouts simply determine how the children are displayed (virtual or not).
        - We will still have to store the true children of every folder, which we'll need depending on the pool used by any virtual folder (e.g. if I set a virtual folder to show the children of some real folder, of course I want the real filesystem children, instead of our virtual representation children). Decide if we separate the true filesystem from the virtual representation into separate tables, or keep everything in the same table but with a real children reference in each real folder.
        - Example: Suppose I have a movies folder with children movie 1, movie 2, etc subdirs. I want to group by "Year". Internally, the backend will create a virtual folder for each year (with the above flag set to make this reversible): For example, there will be a virtual folder for the year 2020, which will be configured to show all children of the movies folder with year 2020. The movies folder will have its children set to those virtual folders instead of its real children. For all intents and purposes, the rest of the system will think that these are the real children of the movies folder. The one exception is the virtual folder system itself, which will need to know the real children of the movies folder, as otherwise a configuration to "show all children of the movies folder with year 2020" would not make any sense. The scanner would also still iterate over the real children in the filesystem, obviously. 
        - Of course, virtual folders will no longer store their settings on the parent real folder. They will become first-class citizens and the logic will be the same as for real folders. (Again, with the exception of the "Files" transient group, which will still be created dynamically when using a sections or tabs layout.)
        - Virtual folders should be a "deep abstraction" (probably in the repo layer), in the sense that most of the backend and frontend should be able to work with them as if they were real folders (whenever it is reasonable and desired), and treat virtual and real folders as similar objects.
        - However, virtual folders will of course never have persisted children in the db, they should always be returned by the repo layer dynamically when requested (and efficiently!). Again, a unified ui is probably preferred, i.e. the service layer just asks for a folder's children, not having to distinguish between real and virtual folders.

2. Implement account support. For now, only differentiate between admin and non-admin users. 
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