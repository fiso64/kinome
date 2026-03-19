# Draft: Field References in VTag Results

## Motivation

VTag result values are currently static strings. To support computed values like
`displayName = title ?? name`, results need to reference other fields dynamically.

## Syntax

Use `{fieldName}` in vtag result values to interpolate field values at evaluation time.

### Field resolution order

1. **Schema fields** — `{title}`, `{name}`, `{year}`, `{mediaType}`, `{path}`, etc.
   Resolved directly from the item/entity.
2. **Unified tag lookup** — `{favorite}`, `{is_animated}`, etc.
   Looks up in custom tags and virtual tags as a single namespace (no prefix needed).
   - Lookup order doesn't matter because collisions are prevented at creation time.

### Examples

```
displayName vtag:
  IF title isNotEmpty → {title}
  Else →               {name}

full_label vtag:
  IF year isNotEmpty →  {title} ({year})
  Else →                {title}
```

## Collision Prevention

Tags and vtags share a namespace. When creating a new tag or vtag, reject if the
name already exists in either set. This mirrors MusicBee's approach.

### Where to enforce

- `createVirtualTag` / vtag settings UI — check existing custom tags
- Custom tag creation (if/when we add a UI for that) — check existing vtags
- Backend validation as the source of truth; frontend can pre-check for UX

## Implementation Scope

### 1. Template evaluation (backend)

TODO: What is the fastest way to do it?

In the vtag evaluator, after determining the result string for a case, expand
`{fieldName}` references:

```typescript
function expandTemplate(template: string, item: LibraryItem): string {
  return template.replace(/\{(\w+)\}/g, (_, field) => {
    // 1. Check schema fields
    if (field in item) return item[field]?.toString() ?? ''
    // 2. Check tags + vtags (unified)
    const tagVal = item.tags?.[field] ?? item.virtualTags?.[field]
    return tagVal ?? ''
  })
}
```

- Only runs when result contains `{` (fast path for static results).
- Vtag dependency order matters: if vtag A references vtag B, B must be
  evaluated first. Need topological sort or lazy evaluation.

### 2. Collision prevention (backend + frontend)

- Backend: validation in vtag save and tag save paths
- Frontend: vtag settings UI shows error if name conflicts with existing tag

### 3. UI hints (frontend)

- FilterEditor / vtag result input: hint or autocomplete for `{...}` syntax
- No special UI needed beyond documentation — curly brace syntax is intuitive

## Open Questions

- **Circular references**: vtag A uses `{B}`, vtag B uses `{A}`. Detect at save
  time via cycle detection, or cap evaluation depth at runtime?
- **Missing values**: `{year}` when year is null — expand to empty string (current
  proposal) or keep the literal `{year}`? Empty string is more useful.
- **Escaping**: `{{literal}}` → `{literal}` if someone needs literal braces?
  Low priority, unlikely in practice.
