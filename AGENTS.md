# Kinome engineering guidance

Kinome is a self-hosted media server and manager. The operator and configured
media roots are trusted.

- Code is a liability. Follow KISS and DRY principles.
- Handle valid work on a best-effort basis. Do not reject it because of estimated
  memory, aggregate size, queue depth, or other internal implementation limits.
  Bound resource use where there is a clear need. For example, batch database
  writes during large library scans and add pagination to large library views
  when needed. Keep small collections simple. Where pagination is needed, favor
  generous page sizes that minimize clicks.
- Isolate failures to the smallest independent item, request, library root, or
  scan phase, within reason. A metadata lookup failure for one title should let
  the rest of the scan proceed. Introduce separate lifecycles only when they
  provide meaningful failure isolation.
- Preserve stable media identities, provider IDs, and exact filesystem paths.
  Keep title parsing and display normalization separate from stored identity and
  path values, and preserve the operator's chosen folder structure.
- Prefer one clear owner, model, and contract. Centralize and simplify behavior.
  Avoid parallel abstractions, speculative configuration, unnecessary
  compatibility layers, and independent persistence lifecycles unless consistency
  or failure isolation genuinely requires them. Start with a refactor, even a
  substantial one, when it makes a feature or bug fix materially simpler.
- Organize by feature and use clear, natural names. Avoid file sprawl.
- Reuse the Web UI's shared styles in `src/renderer/src/assets/` and existing
  Svelte components for common controls. Keep feature styles focused on layout
  and domain states. Keep markup, behavior, and responsive layout common across
  themes, with theme differences limited to visual styling.
- After making changes, redeploy the local testing instance with
  `bun run dev:test` and verify it at `http://localhost:3000`.
- For high-volume SQLite writes, assess database round trips and write
  amplification as well as latency. Prefer set-based operations or prepared,
  batched writes when they preserve ordering, replay, and per-entry failure
  behavior. Mostly avoid json in SQL, especially in cases where those fields are
  used in virtual tags, searching, and filtering, as these must remain highly
  performant even on large libraries.
- Check the performance impact of most feature additions before considering them
  complete. Review how the implementation scales with realistic library sizes and
  repeated use. Look for repeated queries, full scans, unnecessary rendering, 
  extra overhead on requests, and redundant work. Static analysis is sufficient
  when the impact is clear. Run a focused benchmark when it is unclear. Fix
  avoidable costs in the same change so they do not accumulate as the app grows.
- Make server-owned work observable. Log coarse lifecycle and health transitions
  for scans and other background operations at their owner. Include a stable
  operation ID, outcome, duration, and safe, bounded counts where applicable.
  Log terminal failures with the full error once. Use info for operator-relevant
  lifecycle events, debug for routine decisions and detailed timings, rate-limited
  warnings for recoverable degradation, and error for failed operations. Total
  duration can be logged at info. Keep diagnostics in the server or handler that
  performs the work.
- Tests are a maintenance liability as well as an asset. Add them selectively
  and prefer extending existing tests over adding files. Test observable behavior
  and failure isolation. Use stable action IDs for UI tests. Avoid polling and
  fixed waits, keep setup cheap, and remove obsolete or low-value tests while
  preserving meaningful coverage. Suppress application logging in tests unless
  they assert it. Budget the normal `bun test` suite below 30 seconds and run
  expensive load checks separately.
- Change internal logic cleanly and keep compatibility code centralized when
  needed. Normalize old SQLite representations once in a migration. For API changes
  that require breaking the contract, make the change directly, update in-repo
  callers.
