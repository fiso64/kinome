import type { QueryClient, QueryKey } from '@tanstack/svelte-query'

/**
 * Manages throttled execution of TanStack Query refetches.
 * Includes "Leading Edge" (first call is instant) and "Trailing Edge" (guaranteed final execution).
 */
export class QueryThrottler {
  private pendingUpdates = new Map<string, { timer: any; execute: () => void }>()
  private lastExecutionTimes = new Map<string, number>()
  private defaultInterval = 2000 // 2 seconds

  constructor(private queryClient: QueryClient) { }

  /**
   * Refetches a query, applying throttling if shouldThrottle is true.
   *
   * @param queryKey The TanStack Query key to refetch.
   * @param shouldThrottle Whether the application is currently in a high-update state (e.g. scanning).
   */
  throttleRefetch(queryKey: QueryKey, shouldThrottle: boolean) {
    const keyString = JSON.stringify(queryKey)
    const now = Date.now()
    const lastTime = this.lastExecutionTimes.get(keyString) || 0

    const execute = () => {
      this.queryClient.invalidateQueries({ queryKey })
      this.lastExecutionTimes.set(keyString, Date.now())
      this.clearTimer(keyString)
    }

    // Outside of scan mode: Execute immediately
    if (!shouldThrottle) {
      this.clearTimer(keyString)
      execute()
      return
    }

    // Leading Edge: REMOVED for throttled mode to prevent burst spam
    // During a scan (shouldThrottle=true), we want to buffer updates.

    // Trailing Edge: Schedule or reschedule a final update
    if (this.pendingUpdates.has(keyString)) {
      return
    }

    // Force full interval delay during high-load updates to allow batching
    const delay = this.defaultInterval
    const timer = setTimeout(execute, delay)
    this.pendingUpdates.set(keyString, { timer, execute })
  }

  /**
   * Immediately executes all pending deferred refetches.
   * Should be called when a scan finishes.
   */
  flush() {
    for (const [keyString, update] of this.pendingUpdates.entries()) {
      clearTimeout(update.timer)
      update.execute()
    }
    this.pendingUpdates.clear()
  }

  private clearTimer(keyString: string) {
    const pending = this.pendingUpdates.get(keyString)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingUpdates.delete(keyString)
    }
  }
}
