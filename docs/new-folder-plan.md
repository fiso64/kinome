# Feature: Create New Virtual Folder

## Overview

Two deliverables:
1. **Refactor VirtualTagEditor** into a reusable `FilterEditor` component with a boolean-only mode toggle
2. **"New Virtual Folder"** context menu entry + modal + backend wiring

---

## Part 1: Refactor VirtualTagEditor → Reusable FilterEditor

The existing `VirtualTagEditor.svelte` is a single-purpose component for the global settings vtag tab. We need to extract the **condition editing** portion into a reusable `FilterEditor` that supports two modes:

### Props
```ts
{
  conditions: LibraryCondition[]  // bindable, the filter conditions
  booleanOnly?: boolean           // when true, hide the "result" column — conditions are just include/exclude matchers
  defaultResult?: string          // bindable, only shown when !booleanOnly
}
```

### Changes

**New file: `src/renderer/src/components/ui/FilterEditor.svelte`**
- Extracted from VirtualTagEditor's condition rows
- Renders the field/op/value rows with add/remove
- In `booleanOnly` mode: no "Then"/"Result" column, no "Else"/default result — just the conditions list
- In full mode (global settings): shows "If → Then result" rows + "Else default" footer (current behavior)
- Visual polish: slightly better spacing, subtle row numbering, clearer labels

**Modified: `VirtualTagEditor.svelte`**
- Becomes a thin wrapper: tag name input + `<FilterEditor>` for each case + delete button
- Keeps the "cases" concept (multiple condition→result mappings) since vtags need if/else-if/else logic

**No backend changes** — this is purely a UI refactoring.

---

## Part 2: Create New Virtual Folder

### 2a. Backend (TDD)

The backend already has `createUserVirtualFolder(parentId, name, filter?)` and the API endpoint `POST /items/:id/virtual-folders`. These work. What's missing:

**New tests (RED first):**
1. Creating a user vfolder with a filter containing vtag conditions (e.g., `vt.is_anime eq true`) — verify children endpoint resolves it correctly
2. Creating a user vfolder with scope set to a non-parent folder (e.g., scope = library root, but vfolder lives under a subfolder) — verify the pool query respects the explicit scope rather than defaulting to parent
3. Creating a user vfolder with no filter (plain empty folder) — verify it returns empty children
4. Verify user vfolders appear in both grouped and ungrouped states of the parent (spec says `virtual_type = 'user'` is always visible)

**Scope enhancement:**
Currently `LibraryFilter.scope` only supports `{ parentId: string }` (direct children of a folder). The user wants more scope options:

- `{ parentId: string }` — direct children of a specific folder (existing)
- `{ descendantsOf: string }` — all descendants recursively (new)
- `undefined` / omitted — entire library (already works: no scope = no parentId constraint)
- `"inherit"` — use the parent folder's real children as the pool (same as `{ parentId: <vfolder's parentId> }`, this is the default when creating via the modal)

Implementation: extend `compileFilter` to handle `scope.descendantsOf` by generating a recursive CTE or a `path LIKE ?` condition. The "inherit" scope is a frontend concept — when saved, it's stored as `{ parentId: <actual parent id> }`.

### 2b. Frontend Modal

**New modal type: `'createVirtualFolder'`**

Add to `modal-store.svelte.ts`:
```ts
| {
    type: 'createVirtualFolder'
    props: {
      parentId: string      // where the vfolder will be created
      parentName: string     // for display
      onCreated: (id: string) => void
    }
  }
```

**New file: `src/renderer/src/components/modals/CreateVirtualFolderModal.svelte`**

Modal contents (top to bottom):
1. **Name** — text input for the folder name
2. **Scope** — dropdown:
   - "Inherit from parent" (default) — pool = parent's real children
   - "Entire library" — no scope restriction
   - "Children of..." — shows a folder picker (or text input for folder ID)
3. **Filter conditions** — the reusable `<FilterEditor booleanOnly={true}>` component
   - Each row: field dropdown + operator dropdown + value input
   - In boolean mode, conditions are AND-joined: "include items where ALL conditions match"
   - Fields available: all REPOSITORY_SCHEMA fields + vtag keys (fetched from autocomplete suggestions)
4. **Footer** — Cancel + Create buttons

On save:
- Calls `api.createVirtualFolder(parentId, name, filter)` where filter is built from scope + conditions
- Calls `onCreated(id)` callback so the parent view can refresh

### 2c. Context Menu Entry

**In `ContextMenu.svelte`:**
Add a new entry for folders (both real and virtual):
```svelte
{#if item.type === 'folder'}
  <button class="context-menu-item" onclick={handleCreateVirtualFolder}>
    <span class="icon">📁</span>
    <span>New Virtual Folder...</span>
  </button>
{/if}
```

**In `ContextMenuRoot.svelte` and `App.svelte`:**
- Add `onCreateVirtualFolder` action callback
- Action opens the `createVirtualFolder` modal with `parentId = item.id`

---

## Implementation Order

1. **FilterEditor extraction** — refactor VirtualTagEditor, verify global settings still work
2. **Backend scope enhancement** — extend `compileFilter` for `descendantsOf`, write RED tests
3. **Backend tests GREEN** — any fixes needed
4. **CreateVirtualFolderModal** — new modal using FilterEditor
5. **Context menu wiring** — add entry, connect to modal
6. **Integration test** — manual testing of full flow

---

## Scope Decisions to Confirm

1. **Scope "Children of..." picker**: Simple text/dropdown? Or a mini folder tree browser? (I'd suggest starting with a searchable dropdown populated from the item list, and we can upgrade later)
2. **Should the vfolder be navigable immediately after creation?** (Yes — the `onCreated` callback can navigate to it)
3. **Delete virtual folder**: Already implemented in backend. Should we add a context menu "Delete Virtual Folder" entry for `virtual_type = 'user'` items? (Probably yes, as a follow-up)
