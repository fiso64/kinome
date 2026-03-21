
## General
If during implementation you come across any unresolved questions or architectural friction points, stop and raise them to discuss with me.

Prefer architecturally clean solutions over quick hacks. This also applies to existing code: If you find cruft or unclean design that can be abstracted or simplified while implementing something, mention it. Do so even if it looks like an established "design pattern" in the codebase -- propose to fix tech debt when relevant.

## Testing
Important: For **backend** (or shared logic) bugs, always write a red failing test first to confirm the issue in one of the *.test.ts files (or a new file). If the logic is hard to test (e.g. can't be mocked), refactor it first.

Commands:
- `bun test`
- `bun typecheck` (node typecheck + svelte-check) or `bun typecheck:node`

If an issue is proving hard to fix, add some logging and ask me to repro. I will send the logs.

## Breaking Changes
This project is in an early stage of development and currently not public. Breaking changes are therefore completely fine. We allow them to reduce cruft and make large refactors easier.

## Other Files
Sometimes I reference my test library, whose structure is detailed in `docs/test-library-structure.md`. Overall project idea and description is in `README.md`, and the long term plans can be found in `docs/PLAN.md`.