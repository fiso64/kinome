# Spec: Full Virtual Filesystem

**Version:** 0.1
**Status:** Idea
**Related:** `virtual_tags.md`

---


This spec proposes an upgrade to the current virtual tag system to support a full virtual filesystem. Instead of just being able to group some views by virtual tags (which automatically creates corresponding virtual folders), users will be able to create custom virtual folders that can be populated with media items using a set of rules. 

## Examples

### Pooling

Consider a user with two folders, `root/movies` and `root/tv shows`. They might want to see all movies and tv shows in a single view. While it is currently possible to use the root view with a sections layout grouped by folder to see all movies and tv shows inline, users may want a different grouping. For example, maybe we want to group by genre.
Conceptual flow: Define a virtual folder named "All Media" and a rule that includes all items in the library, or a rule that includes all items whose parent is root. Using a new configuration option that determined the default "Home" view, the user could set "All Media" as their home view instead of root. All items will appear as a flat list. User can then use existing grouping functionality to group by genre, year, etc.

### Recently Added

Each real or virtual folder will be allowed to have custom user-defined child virtual folders. 
Take a setup as in the pooling example above. User creates a virtual folder "Recently Added" as a child of "All Media" and a rule that includes all items whose added date is within the last 30 days. We would also pair this with a custom sort feature, allowed user to determine that
1. The contents of the Recently Added folder should be sorted by added date, descending.
2. The All Media folder displays the Recently Added section first before any other section.

## Edge Cases & Unresolved Questions

- How to make it performant?
- Should we use/switch to an id-based system for virtual folder setting storage, instead of identity=definition?
