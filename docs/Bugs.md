After turning this application into a server (formerly: electron app), it looks like assigning numbers and dynamic detail fetching for seasons and episodes when entering a detail view has broken down completely and no longer works. This is a bug that is indicative of the overall poor design and unpredictability of the API: The "Electron-style" architecture — where the frontend essentially possessed a clone of the entire database in memory via the root object—does not scale to a Client-Server model.

We must completely rethink the API contract from scratch, to focus on

1. Performance
2. Maintainability
3. Scalability
   The API is currently poorly designed on all three fronts.
4. It is not performant, because it sends huge amounts of data, even when not everything is needed (such as sending a huge library root object that contains even the cast, seemingly the entire db!). It should only send and request exactly what is needed, when needed.
5. It is not maintainable or scalable, because we haven't clearly defined what triggers what, and when. This leads to unpredictable results such as the above. It is not clearly defined. Adding a new feature always leads to confusion: How much should the frontend be responsible vs the backend? We must discuss this and rigorously define the API, maybe write a spec.

## Lower priority issues

- Displays old stale artwork sometimes. E.g. when a new artwork is added during a scan, navigate into an item and then back. The old one will be displayed, until the page is refreshed.
- Bug: Refreshing takes you out of detail view. Refresh button should also be available in detail view.
- Some actions (like moving an item to trash) trigger an expensive full refresh which is wasteful. Find all such actions and make them more targeted.
- All subdirs of a tv type item should probably be set to season type automatically (even if no season number was found).
