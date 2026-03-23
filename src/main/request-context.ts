/**
 * Request-scoped async context.
 *
 * Stores the authenticated account ID for the duration of an HTTP request using
 * AsyncLocalStorage. This allows repository/service functions to automatically
 * apply per-account visibility filtering without requiring the caller to
 * thread `userId` through every call site.
 *
 * Background operations (scan, maintenance) run outside any HTTP context, so
 * `getCurrentAccountId()` returns undefined and no filtering is applied.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<string>()

/**
 * Bind `accountId` to the current async context.
 * Called once per request in the auth derive step.
 * Uses `enterWith` so the context flows into all downstream async calls.
 */
export function setCurrentAccountId(accountId: string): void {
  storage.enterWith(accountId)
}

/** Returns the account ID for the current request, or undefined outside HTTP context. */
export function getCurrentAccountId(): string | undefined {
  return storage.getStore()
}
