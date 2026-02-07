# View Resolution & Settings Architecture Refactor

## 1. The Problem (Why it's broken)

Consider this folder structure where multiple layouts are nested:
```
├── Blade Runner
│   ├── Short Films
│   │   ├── file1.mkv
│   │   └── file2.mkv
│   └── movie.mkv
```

- **Blade Runner** (Folder). User sets it to `Configured Layout: Sections`, NO child view layout. Our grouping logic will generate a virtual "Files" folder containing the immediate children of "Blade Runner".
  - **Short Films** (Real Folder). User sets it to `Configured Layout: List`.
    - file1.mkv
    - file2.mkv
  - **Files** (Virtual Folder). User sets it to `Configured Layout: Tree`.
    - movie.mkv

**The Bug:**
When a parent folder ("Blade Runner") uses a container layout like `sections`, its children ("Short Films") are rendered as sub-views. If "Short Films" is configured to use a `List` layout, the frontend fails to render it correctly (defaults to Grid) because:
1.  The frontend doesn't know "Short Films" relies on `List` layout until it fetches it.
2.  Because it doesn't know it's a `List`, it fails to request the `overview` field required by `List` view.
3.  Even if it requested `layout`, the current API structure requires fetching the *entire child object* just to see its layout, which is inefficient ("fat" items).
4.  **Crucially:** The initial request for the parent ("Blade Runner") has no mechanism to request the recursive view configuration of its children *in advance*.

**Architecture Flaw:**
We have a circular dependency:
*   Use `getAllRequiredFields` to know what data to fetch.
*   But `getAllRequiredFields` requires `child.layout`.
*   But we can't know `child.layout` until we fetch the child!

Note: `getAllRequiredFields` already correctly checks childViewSettings, but in our example, these are null. These settings are only responsible for setting the default layout for the children of a sections of tabs view; here we have explicitly set the layout for both children and didn't set any childViewSettings.

---

## 2. The Solution (Why it's better)

We will introduce a dedicated **View Hierarchy Side-Channel** and STRICTLY separate view settings from item metadata.

**How it works:**
1.  **Strict Separation:** `MediaFolder` objects will no longer have top-level view settings (e.g. `layout`, `clickAction`). instead, they will have a single `viewSettings` property containing a `StoredViewSettings` object.
2.  **Look-Ahead:** When fetching the parent ("Blade Runner"), the frontend requests `include=viewHierarchy`.
3.  **Recursive Resolution:** The backend recursively resolves the view configuration for the parent AND its logical children (e.g. "Short Films" -> List, "Files" -> Grid).
4.  **Informed Fetching:** The frontend receives this hierarchy *first* (attached to the parent as `viewHierarchy`). It sees: "Ah, the 'Short Films' child I'm about to fetch will be a List."
5.  **Correct Requirements:** `getAllRequiredFields` can now look at this hierarchy and say: "Since 'Short Films' is a List, I must include `overview` in my children request."
6.  **Lean Data:** The children request fetches exactly what is needed (`overview`), without carrying bloat like `childViewSettings` on every item.

**Benefits:**
- **A) Architecture:** Decouples Presentation (View Specs) from Data (Library Items). Eliminates "fat" items.
- **B) Functionality:** Fixes the bug by breaking the circular dependency. The frontend knows *how* to display things before it fetches the *what*.
- **C) Cleanliness:** No more "extracting" settings from mixed objects. View settings are their own entity.

**Architectural Decisions & Constraints:**
- **Legacy Data Policy**: The `view_settings_json` column is the absolute source of truth. We will NOT fall back to top-level database columns (e.g., `layout`, `click_action`) if the JSON is missing or incomplete. No migration logic will be written.
- **GroupBy Constraint**: The `groupBy` property is strictly a partitioning instruction for container layouts (`tabs` and `sections`). It has no effect on "leaf" layouts like `grid`, `list`, or `tree`.
- **Side-Channel Exclusions**: Global views with static requirements (like Search Results or "All Movies") bypass the `viewHierarchy` side-channel. Their field requirements are fixed and do not need dynamic resolution.

### 🚨 NO DATABASE MIGRATIONS 🚨

As explicitly stated in `README.md`, **we will NOT be writing database or JSON migration scripts**.
- The existing database structure (flat view settings) is considered "garbage technical debt" and will be abandoned.
- Attempts to strictly migrate data via code are prohibited. The code will simply read/write the new structure, and if old data doesn't match, it is acceptable for it to be lost or reset to defaults.

---

## 3. Data Structures

### Shared Types (`src/shared/types.ts`)

We introduce a new `ViewHierarchy` type that encapsulates both the stored configuration (for editing) and the effective resolution (for rendering).

```typescript
export interface ViewHierarchyNode {
  /** The ID of the item this node describes (physical or virtual) */
  id: string
  
  /** 
   * The raw, stored settings for this item.
   * Used by: Settings Modals (to show "inherited" vs "overridden" states).
   */
  stored: StoredViewSettings
  
  /**
   * The fully resolved, effective settings for rendering.
   * Used by: MediaView (to determine layout), field collectors.
   */
  effective: ResolvedViewSettings
  
  /**
   * Contextual child settings (if this node acts as a container).
   * Key: Child Item ID (e.g. physical ID or virtual ID)
   */
  children?: Record<string, ViewHierarchyNode>
}

// STRICT SEPARATION: MediaFolder now CONTAINS viewSettings, does not EXTEND it.
export interface MediaFolder extends BaseLibraryItem {
  // ... existing metadata ...
  id: string
  name: string
  type: 'folder'
  // ... other core props ...

  /** 
   * The stored view settings for THIS folder.
   * This is the SOURCE of TRUTH for persistence in the DB.
   */
  viewSettings?: StoredViewSettings
}

export interface LibraryItem extends MediaFolder {
  // ...
  
  /** 
   * Optional side-channel for the resolved view hierarchy tree.
   * Populated ONLY when requested via `include=viewHierarchy`.
   * This is computed, never stored.
   */
  viewHierarchy?: ViewHierarchyNode
}
```

### 🚨 NO EXTENDING CORE_FIELDS 🚨

We will not be adding viewSettings or viewHierarchy to CORE_FIELDS. The client must explicitly request it via the include parameter.

---

## 4. Implementation Steps

### Phase 1: Shared Utilities & Backend Logic

#### 1. Update `types.ts`
- Remove `extends StoredViewSettings` from `MediaFolder` / `BaseLibraryItem`.
- Add `viewSettings?: StoredViewSettings` to `MediaFolder`.
- Add `viewHierarchy?: ViewHierarchyNode` to `LibraryItem` (or extended type).

#### 2. Update `repository.service.ts` / Data Layer
- Ensure `createItem` / `updateItem` reads and writes to `item.viewSettings` instead of top-level keys.
- **NO MIGRATION LOGIC.** Just read the new field. Old fields will be ignored/lost.
- Follow the **Legacy Data Policy**: Stop spreading database row keys to the item root. Map the JSON column directly.

#### 3. Update `resolveViewSettings` (`src/shared/settings-helpers.ts`)
- Refactor to look for `item.viewSettings.layout` instead of `item.layout`.

#### 4. Implement `resolveViewHierarchy` (`src/main/services/grouping.service.ts`)
- **Refactoring Strategy**: Extract a data-agnostic structure helper from `groupItemsRecursive`. This helper should yield the "skeleton" (IDs, Names, Settings) of the hierarchy to ensure Virtual ID generation and Settings inheritance are DRY.
- Recursively build the `ViewHierarchyNode` tree.
- **Input:** `itemId`, `depth`.
- **Termination Policy (Performance)**: 
  - Recursion ONLY continues if the `effective.layout` is a container (`tabs` or `sections`).
  - For container layouts, only the **immediate logical children** (physical subfolders or virtual groups) are resolved.
  - If a child node resolves to a "leaf" layout (e.g., `grid`, `list`, `tree`), recursion stops for that branch.
  - This ensures we only fetch what is needed to render the current "structural" level.
- **Logic:**
  1. Fetch the item.
  2. Access `item.viewSettings`.
  3. Resolve effective settings using `resolveViewSettings`.
  4. Recurse if needed (per the policy above).
  5. Return `ViewHierarchyNode` (as `viewHierarchy`).

#### 5. Update API Endpoint (`src/main/server.ts`)
- Modify `GET /items/:id`.
- Accept `include=viewHierarchy`.
- Call `groupingService.resolveViewHierarchy(id)` and attach result to `item.viewHierarchy`.

---

### Phase 2: Frontend Data Fetching

#### 6. Update `getAllRequiredFields` (`src/renderer/src/lib/view-requirements.ts`)
- Change signature to accept `(viewHierarchy: ViewHierarchyNode)`.
- Traverse the `viewHierarchy` tree.
- Resolve field requirements based on `node.effective.layout`.

#### 7. Update `ItemDetail.svelte`
- Request `include: ['viewHierarchy']` in the initial `itemQuery`.
- Pass `item.viewHierarchy` to `getAllRequiredFields`.
- Pass result to `childrenQuery`.

---

### Phase 3: Component Updates (Consumption)

#### 8. Update `MediaView.svelte`
- Accept `viewNode` prop (ViewHierarchyNode).
- Use `viewNode.effective.layout`.
- Pass relevant child node (`viewNode.children[childId]`) to recursive `MediaView` components.

#### 9. Update `ItemSettingsModal.svelte`
- Read/Write to `item.viewSettings` (StoredViewSettings).
- No more top-level/mixed property access.

---

## 5. Audit Findings & Remaining Tasks

A comprehensive audit of the codebase has revealed several areas where logic remains "mixed" or where naming collisions exist. These must be addressed as part of the refactor.

### 🚩 Critical Naming Correction
- [x] **Property Rename**: Rename `LibraryItem.viewSettings` (the Side-Channel) to `LibraryItem.viewHierarchy` in `src/shared/types.ts`.
    - *Reason*: Avoids collision with `MediaFolder.viewSettings` (the Stored Settings).
    - *Impact*: Update `server.ts`, `ItemDetail.svelte`, and `view-requirements.ts`.

### 🚨 Backend Cleanup (Data Layer)
- [x] **`repository.service.ts` -> `mapRowToLibraryItem`**:
    - [x] MUST move view fields (layout, clickAction, etc.) from top-level of the row into `item.viewSettings`.
- [x] **`repository.service.ts` -> `_updateItem`**:
    - [x] Update to read from `updates.viewSettings` and serialize to the `view_settings_json` column. 
    - [x] Remove legacy top-level key processing (e.g., `updates.layout`).
- [x] **`repository.service.ts` -> `CORE_FIELDS`**:
    - [x] Exclude all view-related fields from "core" metadata.

### 🏗️ Backend Cleanup (Services)
- [x] **`library.service.ts` -> `updateItem`**:
    - [x] Update both physical and virtual folder update logic to use the `viewSettings` property for storage.
- [x] **`grouping.service.ts` -> `resolveViewHierarchy`**:
    - [x] Update to read settings from the nested `item.viewSettings` (once `mapRowToLibraryItem` is updated).
- [x] **`server.ts`**:
    - [x] Change `include=viewSettings` to `include=viewHierarchy`.

### 🎨 Frontend Cleanup (Consumption)
- [x] **`TabsView.svelte` / `SectionsView.svelte`**:
    - [x] **CRITICAL**: Remove manual object spreading: `parentForMediaView = { ...folder, ...container?.childViewSettings }`.
    - [x] These components MUST rely exclusively on the `viewNode` side-channel for recursion.
- [x] **`MediaView.svelte`**:
    - [x] Ensure layout resolution prioritize `viewNode.effective.layout`.
- [x] **`ItemSettingsModal.svelte`**:
    - [x] Update `refreshItemDetails` and `buildUpdatedItem` to handle the nested `viewSettings` structure.
    - [x] Update `initialValues` to track the nested object.

## 6. Verification
- Run `bun run typecheck` to verify types are correct.
- Verify `Blade Runner` -> `Short Films` (List View) scenario.
- Verify `Movies` -> `Genre` (Tabs) scenario.
- Verify `User Settings` (Edit Mode) correctly shows inherited vs overridden values.
