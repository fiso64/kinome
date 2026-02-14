/**
 * MIGRATION POLICY
 * 
 * Kinome follows a "Breaking Changes are OK" policy during its current development phase.
 * We do not implement traditional database migrations (schema migrations or data transformations)
 * to keep the architecture lean and avoid technical debt associated with supporting legacy schemas.
 * 
 * If the database schema changes significantly:
 * 1. The user is expected to delete their `library.db` and perform a fresh scan.
 * 2. The re-scanner (Phase 1 & Phase 2) will naturally rebuild the authoritative state from the filesystem.
 * 
 * Note: Structural synchronization (identifying TV shows/seasons) is now integrated into
 * the authoritative scanner logic rather than being a separate migration step.
 */
