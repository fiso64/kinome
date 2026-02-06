# Kinome Fixes & Improvements


## episode number reassignment
Support changing season and episode numbers for episode files.
Bug: When episode numbers are interchanged (e.g. 1 <-> 2), the episodes do not swap metadata.
    - Performing a rescan after interchanging removes all metadata from both episodes.
    - Also, after performing a rescan, the episodes have their old numbers back (no locks/locks are not respected?).

## Resolving complex view settings 
**Setup:**
1.  **Library Structure:**
    *   Root
        *   `Breaking Bad` (TV Show)
            *   `Season 1` (Folder)
                *   `Episode 1.mkv` (File)
2.  **View Settings (Root):**
    *   Layout: `Sections`
    *   Group By: `Folder`
3.  **Visual Result:** The Root View correctly creates a Section for "Breaking Bad" and unwraps "Season 1" into a tab/section.

**Symptoms:**
*   The episodes listed inside the "Season 1" tab are missing the `overview` field (and potentially others like `seasonNumber`).
*   This results in empty text areas where descriptions should be, or fallback rendering.
*   **Contrast:** Opening `Breaking Bad` directly (Detail View) displays the same structure *correctly* with all fields populated.

**Root Cause Analysis:**
The issue stems from how the Frontend calculates which database fields to request from the Backend (`getAllRequiredFields`).

1.  **Requirement Calculation:** The Frontend looks at the container's View Settings to determine what layout its children will use.
2.  **Implicit Defaults:**
    *   **TV Show Detail View:** The container has `mediaType: 'tv'`. The `resolveViewSettings` helper detects this and explicitly injects the "Default Season Layout" (List View) as the `childViewSettings`. Since List View requires `overview`, the Frontend requests it.
    *   **Root View:** The container is a generic folder (`mediaType: null`). `resolveViewSettings` **does not** inject any implicit defaults. It assumes the content will be displayed using the generic default (Grid), which does *not* require `overview`.
    *   When the root view is set to be grouped by sections with a configured child layout (e.g. list), then it works correctly. Why? Because `getAllRequiredFields` checks the childViewSettings, which are non-null in this case. The problem is that we over-rely on the childViewSettings, which only reflect user overrides, and not any automatic defaults. 

Proposed fix: Instead of injecting the view settings into the item object, refactor resolveViewSettings to return a lightweight view settings object, possibly nested where needed (depending on if recurse: true). Then extend the items api to add an optional include parameter `viewSettings`, with an option for either recursive or non-recursive. When the client requests either of these, we get the output of resolveViewSettings and send it to the client. The getAllRequiredFields function should then be updated to use this new object instead. Moreover, we will stop storing view settings directly inside the items, and instead store them in `viewSettings` subkey.

## Clean up requests
Clean up all duplicate/redundant API requests from the frontend. 
Also check if there are any waterfall problems.

## getChildren
Audit all usage of getChildren (incredibly bloated)

# Lower priority issues
- Some actions (like moving an item to trash) trigger an expensive full rescan which is wasteful. Find all such actions and make them more targeted.
- Fix the backdrop pop-in when navigating into a detail view for the first time.
- All subdirs of a tv type item should probably be set to season type automatically (even if it doesn't have a season number). Purpose: Consistent ui. When I switch from S01 to the Specials tab, it should use the same season display defaults (list view). Assigning season type is the most straightforward way to do this.
