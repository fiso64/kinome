# Multi-Account Support Plan

## Goals

- Two account types: **Admin** (full access) and **Normal** (read-only + own user state)
- Netflix-style login screen with username + password
- Per-account watched state (and future per-account fields)
- Frontend permission gating that scales cleanly as permissions grow
- Remove `allowUnauthenticated`

---

## Account Model

### Database

New `accounts` table in SQLite. Remove `adminPasswordHash` and `allowUnauthenticated` from `settings.json` entirely.

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'normal',  -- 'admin' | 'normal'
  created_at INTEGER NOT NULL
)
```

The existing setup flow (`/api/setup-admin`) creates the first admin account in this table.

**Why DB and not `settings.json`?**
`settings.json` was fine for a single admin hash. Multiple accounts require unique constraints, queries ("find by username"), and atomic writes — exactly what a database is for. All other structured, growing records (user_state, folder_settings, library items) are already in SQLite. Accounts belong there too.

### Session Layer

Extend in-memory sessions from `Set<token>` to `Map<token, SessionData>`:

```typescript
interface SessionData {
  accountId: string
  role: AccountRole
  capabilities: Set<Capability>  // cached to avoid DB lookup per request
}
```

Elysia middleware attaches a typed `account` object to every request context.

---

## Capabilities Model

**RBAC with a flat capability set.** Roles are named bundles of capabilities defined server-side. The server computes the capability list and sends it to the client in the auth response — the client never needs to know which role maps to which capability.

```typescript
// shared/types.ts
export type Capability =
  | 'editMetadata'
  | 'editSettings'       // global + library settings
  | 'manageAccounts'
  | 'triggerLibraryScan'
  // future: 'exportData', etc.

export type AccountRole = 'admin' | 'normal'
```

```typescript
// server-side only
const ROLE_CAPABILITIES: Record<AccountRole, Capability[]> = {
  admin: ['editMetadata', 'editSettings', 'manageAccounts', 'triggerLibraryScan'],
  normal: [],
}
```

`editViewSettings` is intentionally **not** a global capability — see Folder Ownership section below.

### Auth Response

```typescript
interface AuthResponse {
  authenticated: boolean
  needsSetup: boolean
  account?: {
    id: string
    username: string
    role: AccountRole
    capabilities: Capability[]  // computed server-side
  }
}
```

---

## Per-User Data

### `user_state` Table

Current PK is `item_id TEXT PRIMARY KEY` (single-user). Change to composite:

```sql
PRIMARY KEY (item_id, user_id)
```

Breaking change — existing watched history is discarded, schema reset. This is fine.

### Future: Per-User View Settings

`folder_settings` is currently keyed by `item_id` only. If users eventually get independent view preferences (layout, sort order, grid size) for shared folders, this table will also need a `(item_id, user_id)` composite PK — same pattern as `user_state`. Not implemented now, but the shape of the change is known.

---

## Folder Ownership & View Settings

### Decision: Defer Per-User Home Folders, Do Scaffolding Now

Normal users will eventually have their own home folder (a personal virtual folder) and be able to create/configure virtual subfolders within it. The full implementation is deferred, but the scaffolding is added now because it costs almost nothing and avoids a structural change later.

### Ownership Scaffolding

Add `owner_id TEXT` (nullable) to the virtual folders table:
- `NULL` = admin-owned / shared
- `<account_id>` = owned by that user

### Permission Predicate

Rather than a static `editViewSettings` capability, folder edit access is a contextual check:

```typescript
function canEditFolder(account: Account, folder: Folder): boolean {
  if (account.role === 'admin') return true
  if (folder.type === 'real') return false           // normals never edit real folders
  return folder.ownerId === account.id               // owns this virtual folder
}
```

This function is the single source of truth for folder edit access — used server-side for enforcement and passed to the frontend for UI gating.

### Current Behavior for Normal Users

No personal home folder is auto-created yet. Normal users see the global shared view, read-only. Folder settings controls are greyed out when `canEditFolder` returns false.

### Future: Personal Home Folders

When implemented: auto-create a virtual folder with `owner_id = account.id` on account creation, and set it as that user's root. The `canEditFolder` predicate already handles this without any changes.

---

## Frontend Permission Gating

### Reactive `can` Object

Expose a `can` object from the auth store, derived from the capabilities list:

```typescript
// auth-store.svelte.ts
let capabilities = $state<Set<Capability>>(new Set())

export const auth = {
  // ...existing fields...
  get can() {
    return {
      editMetadata: capabilities.has('editMetadata'),
      editSettings: capabilities.has('editSettings'),
      manageAccounts: capabilities.has('manageAccounts'),
      triggerLibraryScan: capabilities.has('triggerLibraryScan'),
    }
  }
}
```

Usage at call sites — no special component needed:

```svelte
{#if auth.can.editMetadata}
  <EditMetadataButton />
{/if}

<!-- or grey out -->
<button disabled={!auth.can.editSettings}>Settings</button>
```

For folder-contextual gating, pass the result of `canEditFolder` down as a prop.

### Adding a New Capability

1. Add to `Capability` type in `shared/types.ts`
2. Add to `ROLE_CAPABILITIES` on the server
3. Add one getter line to `can` in `auth-store.svelte.ts`

TypeScript will flag anywhere exhaustive handling is needed.

---

## Device-Local Settings

`enabledPlayerIds` and other client settings in `localStorage` are already per-device with no account concept. Leave them completely alone.

---

## UI Changes

- **Login screen**: Netflix-style, username + password, account picker
- **Settings → Accounts tab**: Admin-only, create/delete accounts (already has the tab)
- **Greyed-out controls**: Wherever `auth.can.*` or `canEditFolder` is false
- **Removed**: `allowUnauthenticated` setup option and all related UI

---

## What Is NOT Changing (Yet)

- Per-user view settings for shared folders (layout, sort, grid size) — future `(item_id, user_id)` keyed `folder_settings`
- Personal home folder auto-creation
- Any granularity beyond admin/normal
