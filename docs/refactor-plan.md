# View Resolution & Settings Architecture Refactor

## 1. The Problem (Why it's broken)

**The Bug:**
When a parent folder ("Blade Runner") uses a container layout like `sections`, its children ("Short Films") are rendered as sub-views. If "Short Films" is configured to use a `List` layout, the frontend fails to render it correctly (defaults to Grid) because:
1.  The frontend doesn't know "Short Films" relies on `List` layout until it fetches it.
2.  Because it doesn't know it's a `List`, it fails to request the `overview` field required by `List` view.
3.  Even if it requested `layout`, the current API structure requires fetching the *entire child object* just to see its layout, which is inefficient ("fat" items).
4.  **Crucially:** The initial request for the parent ("Blade Runner") has no mechanism to request the recursive view configuration of its children *in advance*.

**Architecture Flaw:**
We have a circular dependency:
*   Use `getAllRequiredFields` to know what data to fetch.
*   But `getAllRequiredFields` depends on `child.layout`.
*   But we can't know `child.layout` until we fetch the child!

---

## 2. The Solution (Why it's better)

We will introduce a dedicated **View Hierarchy Side-Channel**.

**How it works:**
1.  **Look-Ahead:** When fetching the parent ("Blade Runner"), the frontend requests `include=viewSettings`.
2.  **Recursive Resolution:** The backend recursively resolves the view configuration for the parent AND its logical children (e.g. "Short Films" -> List, "Files" -> Grid).
3.  **Informed Fetching:** The frontend receives this hierarchy *first*. It sees: "Ah, the 'Short Films' child I'm about to fetch will be a List."
4.  **Correct Requirements:** `getAllRequiredFields` can now look at this hierarchy and say: "Since 'Short Films' is a List, I must include `overview` in my children request."
5.  **Lean Data:** The children request fetches exactly what is needed (`overview`), without carrying bloat like `childViewSettings` on every item.

**Benefits:**
- **A) Architecture:** Decouples Presentation (View Specs) from Data (Library Items). Eliminates "fat" items.
- **B) Functionality:** Fixes the bug by breaking the circular dependency. The frontend knows *how* to display things before it fetches the *what*.

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

// Update LibraryItem to remove view props from core interface
// (Mark as deprecated first, then remove)
export interface LibraryItem {
  // ... existing metadata ...
  // DEPRECATED: layout?: string
  // DEPRECATED: childViewSettings?: StoredViewSettings
  // DEPRECATED: groupBy?: string
  // ...
  
  /** Optional side-channel for the view hierarchy, populated if requested */
  viewSettings?: ViewHierarchyNode
}
```

---

## 4. Implementation Steps

### Phase 1: Shared Utilities & Backend Logic

#### 1. Update `resolveViewSettings` (`src/shared/settings-helpers.ts`)
Refactor to support return types compatible with the new structure.

#### 2. Implement `resolveViewHierarchy` (`src/main/services/grouping.service.ts`)
Create a new service method that recursively builds the `ViewHierarchyNode` tree.
- **Input:** `itemId`, `depth` (or `recursive: boolean`).
- **Logic:**
  1. Fetch/Construct the item (physical or virtual).
  2. Resolve its settings using `resolveViewSettings`.
  3. If layout is `tabs`/`sections` (or `recursive` is true):
     - Identify logical children (grouping buckets or physical subfolders).
     - Recursively call `resolveViewHierarchy` for each child.
  4. Construct and return the `ViewHierarchyNode`.

#### 3. Update API Endpoint (`src/main/server.ts`)
- Modify `GET /items/:id`.
- Accept `include=viewSettings`.
- If present, call `groupingService.resolveViewHierarchy(id)` and attach result to `item.viewSettings`.
- **Note:** Ensure `GET /items/:id/children` does *NOT* return `viewSettings` by default (keep it lean).

---

### Phase 2: Frontend Data Fetching

#### 4. Update `getAllRequiredFields` (`src/renderer/src/lib/view-requirements.ts`)
- Change signature to accept `(viewSettings: ViewHierarchyNode)`.
- Traverse the `viewSettings` tree.
- For each node, resolve field requirements based on `node.effective.layout`.
- Union all requirements.

#### 5. Update `ItemDetail.svelte`
- Request `include: ['viewSettings']` in the initial `itemQuery`.
- Pass `item.viewSettings` to `getAllRequiredFields`.
- Pass result to `childrenQuery`.

---

### Phase 3: Component Updates (Consumption)

#### 6. Update `MediaView.svelte`
- Accept `viewSettings: ViewHierarchyNode` prop.
- Use `viewSettings.effective.layout` directly (stop calling `resolveViewSettings` inside the component).
- Pass relevant child node (`viewSettings.children[childId]`) to recursive `MediaView` components.

#### 7. Update `ItemSettingsModal.svelte`
- Initialize form state from `item.viewSettings.stored` instead of `item.layout`, etc.
- This ensures the editor works with the "raw" values for saving/resetting.

---

## 5. Cleanup & Verification

- [ ] Remove `layout`, `childViewSettings`, `groupBy` etc. from `CORE_FIELDS` in `repository.service.ts`.
- [ ] Verify `Blade Runner` -> `Short Films` (List View) scenario.
- [ ] Verify `Movies` -> `Genre` (Tabs) scenario.
- [ ] Verify `User Settings` (Edit Mode) correctly shows inherited vs overridden values.
