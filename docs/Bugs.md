# Fix me

## No retry logic for fetching
There is no retry logic for fetching metadata and assets from TMDB. If during initial library scan and fetch, there is a network problem, then not only will the fetcher not retry, but it seems like it will also mark the item as fetched (non null lastRefreshedAt). This will cause the item to be skipped in the next scan, even if the network problem is resolved.

## Unauthenticated access is enabled by default(!)
The following settings.json wrongly allows unauthenticated access:
```json
{
  "adminPasswordHash": "$2b$10$6lUASs2ZAojjtKFXq0W4N.O2rr23G3ZrD0mOcgNd4fDTvffeAB87C",
  "libraryLocation": "C:/Users/fiso/Source/repos/media-browser/test/media-browser-test-lib/.library",
  "serverPort": 3000, // or missing, same effect
  "allowedIPs": [] // or missing, same effect
  // no boolean allowUnauthenticated: false
}
```

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

## Clean up requests
Clean up all duplicate API requests in general. 

## getChildren
Audit all usage of getChildren (incredibly bloated)

# Lower priority issues
- Some actions (like moving an item to trash) trigger an expensive full rescan which is wasteful. Find all such actions and make them more targeted.
- Fix the backdrop pop-in when navigating into a detail view for the first time.
- All subdirs of a tv type item should probably be set to season type automatically (even if it doesn't have a season number). Purpose: Consistent ui. When I switch from S01 to the Specials tab, it should use the same season display defaults (list view). Assigning season type is the most straightforward way to do this.
