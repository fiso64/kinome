# Fiks Me

## Continue watching in HOME VIEW not updating
Continue watching elements do not update automatically when I watch the next episode. The next up item in the tv show detail view updates fine.

## View is empty after initial setup
After initial setup, the view is empty. I have to refresh the page to see the content. Websocket issue?
Edit: It refreshes on its own after some time. Why not instantly though?

## Changing media source path and library location
Really think about what exactly happens (or should happen) when changing the media source path and library location, both via UI and via config file. In particular:
- What if I set an invalid dir in either of the two paths?
- If I change the media source path without changing the library path, what happens with the db file?

## Stream cache
- There are probably some cache issues with streaming while a file is changing (e.g. while it's downloading). 
- When a file is replaced, the stream cache is not updated.

## Scoped scans
Scoped scans. 

# Can be done later

## High CPU usage
- Kinome uses 25% CPU on my Odroid C4 during the initial scan. Need to investigate.
- Also spikes to 10% briefly when I just refresh the page. 

## Heuristics
Also add some high confidence heuristics. E.g.: When parent has automatic children type hint and folder only has ONE video file, assume movie. Need to tell the fetcher service whenever there is no explicit type hint and we are using a heuristic to be vigilant -- e.g. when we determine something is probably a movie and the retriever does not find that movie, try shows instead (and vice versa).

## Clicking on nested search results
I have noticed an issue, where when an item returned by the search results is not an immediate child of root but nested in another subfolder and I click on it, there are different buggy behaviors in the search results depending on type:
- in full search view, the item is simply not selected when I nav back into the search view (it navigates into detail view just fine though)
- in popout mode, the popout is not closed and search query is not cleared after the item is selected, though again it opens its detail view just fine.

## episode number reassignment
Support changing season and episode numbers for episode files.
Bug: When episode numbers are interchanged (e.g. 1 <-> 2), the episodes do not swap metadata.
    - Performing a rescan after interchanging removes all metadata from both episodes.
    - Also, after performing a rescan, the episodes have their old numbers back (no locks/locks are not respected?).

## Clean up requests
Clean up all duplicate/redundant API requests from the frontend. 
Also check if there are any waterfall problems.

## getChildren
Audit all usage of getChildren (incredibly bloated)

# Lower priority issues
- Some actions (like moving an item to trash) trigger an expensive full rescan which is wasteful. Find all such actions and make them more targeted.
