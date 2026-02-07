# Spec: Grouping and Layouts

**Version:** 1.4
**Status:** Implemented
**Related:** `spec/backend/virtual_tags.md`

---

## 1. Abstract

Kinome's viewing engine is split into two distinct systems: **Layout Resolution** and **Logical Grouping**. While Layout Resolution handles the visual style (e.g., Grid, List, Sections), Logical Grouping handles the organization of items into hierarchical virtual structures. This document defines the algorithms, invariants, and hierarchical logic that merge these two systems into a seamless, deeply nested browsing experience.

## 2. Layout Resolution: The Cascading Model

Layout Resolution is the process of determining the effective visual settings (layout type, poster size, click actions) for any container. It uses a calculated specificity cascade where specific instructions override generic ones.

### 2.1 The Specificity Cascade

When resolving settings for an item, the system builds a stack of `StoredViewSettings` layers. The **first** layer to define a scalar property (like `layout`) wins.

The order of specificity is (from highest to lowest):

1.  **Direct Override**: An explicit instruction from a parent targeting exactly this child's ID.
2.  **Inherited Context**: The general `childViewSettings` passed down from a parent (e.g., "all items in this section should be Lists").
3.  **Local Item Settings**: Settings saved directly on the physical folder in the database.
4.  **Media-Type Defaults**: Global defaults for the category (e.g., `tv`, `movie`, `season`).
5.  **Global System Default**: The absolute fallback for all folders (`_default`).

<!-- ### 2.2 Additive Merging of Complex Maps
Unlike scalar properties, complex maps like `overrides` and `virtualFolderSettings` are **merged** across all cascade layers. This ensures that:
- A local override for a specific sub-child complements general parent instructions.
- Global rules for common virtual tokens (like "Genre: Horror") coexist with folder-specific customizations.
TODO: Think about this section. We probably don't want to do that, but it was needed to fix a bug related to virtual folders. -->

## 3. Logical Grouping: Virtual Architecture

Logical Grouping is the algorithmic process of partitioning a flat list of media items into a tree of **Virtual Folders**. This is triggered whenever a resolved layout is a container type (`tabs` or `sections`).

### 3.1 Structural Grouping (`groupBy: folder`)

The `folder` grouping key is the most complex organizational mode. It respects the physical filesystem while adding "Smart Virtualization" to improve the browsing experience for mixed media types.

#### Step 1: Physical Categorization
The algorithm (`categorizeItems`) splits the input list into two buckets:
- **Physical Folders**: Direct sub-directories in the filesystem.
- **Loose Files**: Individual media items (Movies, Episodes) present in the current directory.

#### Step 2: Smart File Virtualization
If **Loose Files** are present, the system does not display them as a flat list mixed with folders. Instead, it applies a secondary partitioning logic:
1.  **Season Detection**: It looks for a `seasonNumber` on every file.
2.  **Season Grouping**: Files with a valid season number are grouped into virtual **Season Folders**.
    - **Title**: "Season {N}"
    - **MediaType**: Forced to `season` to trigger correct layout defaults.
3.  **The "Files" Catch-all**: Any remaining files (without a season number) are grouped into a virtual **"Files"** folder.
    - **Title**: "Files"
    - **MediaType Evaluation**: If the first file in this group is an `episode`, the folder is typed as `season`; otherwise it is `null`.

#### Step 3: Container Recursion
If a **Physical Folder** (e.g., a TV Show folder) is determined to be a "Container" (its resolved layout is `tabs` or `sections`), the system **recursively** enters that folder.
- It fetches the children of that folder.
- It applies the folder's own grouping logic (e.g., creating Season tabs inside the show).
- The parent then receives this entire virtualized subtree to display as its child context.

### 3.2 Semantic Grouping (Metadata-based)

Semantic grouping partitions items by their properties (e.g., `genres`, `year`, `tags`).

#### The Partitioning Algorithm
1.  **Value Extraction**: The system iterates through the items, extracting values for the target key.
2.  **Multi-value Cloning**: If an item has multiple values (e.g., Genres: "Action" and "Sci-Fi"), it is included in **both** corresponding virtual groups.
3.  **Uncategorized Fallback**: If an item has no values for the key, it is placed in a virtual folder named **"Uncategorized"**.

### 3.3 Virtual Identity & Tokens

Virtual folders are ephemeral but must support persistent settings. This is achieved through **Token-based Identity**.

- **Tokens**: Every virtual folder is defined by a token representing its creation rule (e.g., `genre:Horror`, `year:2024`, `folder:__season_1__`).
- **Token Paths**: In nested scenarios, tokens are joined (e.g., `genre:Horror/year:2024`).
- **ID Generation**: Virtual IDs are built by hashing the parent's physical ID and appending the token path: `virtual--{parentUUID}--{tokenPath}`.
- **Settings Persistence**: When a user saves a setting for a virtual folder, it is stored in the **Physical Parent's** `virtualFolderSettings` map, keyed by the folder's token path.

## 4. Architectural Invariants

These invariants are the "Laws" of the Kinome view engine.

### I1: Invariant of Direct View Isolation
**"Items requested directly are resolved in a vacuum."**
When a user navigates to a folder (Full View), the `inheritedSettings` context is strictly `undefined`. This ensures a folder always presents its own intended style, preventing a parent's "styling intent" from leaking into standalone navigation.

### I2: Invariant of Inline Inheritance
**"Parent intent only propagates through the side-channel of container views."**
A parent only influences a child when that child is rendered *inside* the parent (Tabs/Sections). This inheritance is temporary and context-bound.

### I3: Invariant of Mixed Content Fallback
**"TV shows must default to Season content layouts even when customized."**
If a TV show defines child overrides (e.g., for an "Extras" folder) but does *not* define a general layout for its children, the engine automatically injects the **Season Default** into the cascade. This prevents episodes/seasons from accidentally inheriting a "TV Show" (Tabs) layout.

### I4: Invariant of Virtual Ancestry
**"Virtual folders carry identity, not context."**
Virtual folders carry two things from their parent:
1.  Their own identity settings (layout, title) from the parent's `virtualFolderSettings`.
2.  The map itself (to allow further nesting).
They do NOT inherit the parent's current layout or general child defaults when accessed directly.

## 5. Implementation Details: Special Folders

| Folder Type | Token | Name | Logic |
| :--- | :--- | :--- | :--- |
| **Physical** | N/A | Disk Name | Real filesystem directory. |
| **Season** | `folder:__season_{N}__` | Season {N} | Files with `seasonNumber = N`. |
| **Files** | `folder:__files__` | Files | Loose files in a mixed physical/file directory. |
| **Uncategorized**| `{key}:Uncategorized` | Uncategorized | Metadata key is missing or empty. |
| **Unknown** | `year:Unknown` | Unknown | Special case for missing numeric metadata. |

## 6. Tree Side-Channel (`viewHierarchy`)

To enable responsive navigation and "Deep Tabs," Kinome provides a side-channel API called `viewHierarchy`.
- **Purpose**: It allows the frontend to know the entire layout tree (nested tabs/sections) before fetching heavy item metadata.
- **Scope**: Resolves logical structure and view settings. It does NOT return file lists or posters.
- **Recursion**: It follows the container structure as deep as the library defines (no hardcoded depth limits).

## 7. Edge Cases & Error Handling

- **Circular Nesting**: The `resolveEffectiveSettings` service maintains a `visited` set to prevent infinite loops in cases of circular folder/tag references.
- **ID Collisions**: IDs are deterministic based on the full token path from the physical anchor, ensuring that deep nested paths (e.g., `A > B > C`) have unique identities even if the same folder value appears elsewhere.

## 8. Unresolved Questions

### Q1: Merging of `virtualFolderSettings` Map
- **Current Decision**: **Merged** (Temporary). Allows global virtual rules to coexist with local overrides.
- **Debate**: Should a local map entirely replace the global one for a specific branch?

### Q2: Virtual Folder Storage Migration
- **Status**: Researching a move from "Parent-based storage" to a dedicated virtual-folder database table to treat virtual folders as first-class citizens.
