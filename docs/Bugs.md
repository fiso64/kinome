# Fix me

## search bar in detail view bug
1. navigate to http://localhost:3000/
2. open any detail view item
3. type `t` in the search bar
  - the full page search ui will appear
  - expected: search results ui popup (not page), which doesn't modify browser history or url.

## Search bar autocomplete suggestions are broken again.
Search bar autocomplete suggestions are broken again. They do not appear at all when I type `:`. No errors in the logs. Frontend DOES request autocomplete-suggestions from server and they are correctly returned.

## Triple children request on page load
When loading root view which is set to be grouped by sections, two layers deep like so:
```
# sections by virtual tag is_animated = Animation if genre includes Animation, else Live Action
## sections by mediaType
### grid view (default)
```
I observe the following THREE requests during page load:

http://localhost:3000/api/v2/items/root/children?include=id%2CparentId%2Cname%2Ctype%2CmediaType%2CposterPath%2Cwatched%2CisMissing%2Cyear%2CseasonNumber%2CepisodeNumber%2CvirtualTags
http://localhost:3000/api/v2/items/root/children?include=id%2CparentId%2Cname%2Ctype%2CmediaType%2CposterPath%2Cwatched%2CisMissing%2Cyear%2CseasonNumber%2CepisodeNumber
http://localhost:3000/api/v2/items/root/children?include=id%2CparentId%2Cname%2Ctype%2CmediaType%2CposterPath%2Cwatched%2CisMissing%2Cyear%2CseasonNumber%2CepisodeNumber

Gemini said this:
```
The reason you currently see 3 requests is likely because of the **Configuration Waterfall** I mentioned earlier:

1.  **Request 1:** `getAllRequiredFields` runs on `undefined` (defaults to Grid) -> Fetches only `posterPath`.
2.  **Request 2:** Root loads. `getAllRequiredFields` runs on the recursive object above -> Fetches `posterPath, virtualTags, mediaType`.
3.  **Request 3:** Likely a reactivity side-effect where the `groupBy` change triggers a query key update before the `fields` update is fully processed, or vice versa.

**The Fix:**
Ensure `childrenQuery` is `enabled: !!currentFolder` (Dependent Query).
This forces the frontend to wait until it has the recursive `rootSettings` map (Step 1) before it attempts to traverse it (Step 2) and fetch data (Step 4).
```
Must debug this first. request 3 is clearly just a guess. We don't know what causes it.

## getChildren
Audit all usage of getChildren (incredibly bloated)

## Fix shortcuts in web version and context menu
- right clicking a second time should show the native browser context menu
- we should disable all reserved shortcuts in the web version (ctrl+f, alt+d, etc).

# Lower priority issues
- Some actions (like moving an item to trash) trigger an expensive full rescan which is wasteful. Find all such actions and make them more targeted.
- Fix the backdrop pop-in when navigating into a detail view for the first time.
- All subdirs of a tv type item should probably be set to season type automatically (even if it doesn't have a season number). Purpose: Consistent ui. When I switch from S01 to the Specials tab, it should use the same season display defaults (list view). Assigning season type is the most straightforward way to do this.
