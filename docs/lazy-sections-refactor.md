# Lazy Section/Tab Loading Refactor

## Current Architecture

`getChildren` on the backend calls `embedChildrenForContainers()` after fetching direct children. When the resolved layout is `tabs` or `sections`, it recursively fetches each child folder's children and embeds them directly into `folder.children`. This means a single HTTP request returns the full nested tree.

`SectionsView` and `TabsView` on the frontend simply read `folder.children` — they never issue their own queries.

The original motivation was to avoid N+1 HTTP requests.

## The Problem

1. **TabsView fetches all tabs upfront**, even though only one tab is visible at a time. All season episode lists are fetched when the user opens a show, regardless of which season they look at.

2. **SectionsView fetches all sections upfront**, even when most are off-screen. A genre browser with 30+ sections fetches all of them on load, most of which the user will never scroll to.

3. **Slow subfolders block the entire render.** One large or slow virtual folder holds up everything.

4. **Sections can't have independent loading states.** It's all-or-nothing — precludes per-section skeletons and progressive rendering.

## Proposed Architecture

Remove `embedChildrenForContainers` from the backend. Let the frontend fetch lazily:

- **TabsView**: issue a `getChildrenQuery` for the active tab only. Pre-fetch one adjacent tab if desired.
- **SectionsView**: issue a `getChildrenQuery` per section, triggered by an `IntersectionObserver` as sections scroll into view. Show a skeleton per section until its data arrives.

The N+1 concern is real (server can be remote, round-trips cost real latency) but the eager approach is the wrong answer for realistic use cases:
- Few sections: parallel lazy fetches fire nearly simultaneously, latency is `max(individual)` not `sum`
- Many sections (genres, etc.): eager is strictly worse — fetches data the user will never see

## What's Needed

- Remove `embedChildrenForContainers` from `navigation.service.ts`
- `SectionsView`: add `IntersectionObserver` per section, call `libraryDataService.getChildrenQuery(folder.id)` when in view
- `TabsView`: call `getChildrenQuery(activeTab.id)` reactively on tab change
- Both views: show per-section/tab skeletons while their query is pending
- May want a small pre-fetch buffer in `SectionsView` (e.g. fetch 1-2 sections ahead of the viewport)

## Related

This refactor is a prerequisite for accurate per-section skeleton loading in `SectionsView` and `TabsView`.
