import type { QueryClient, QueryKey } from '@tanstack/svelte-query'

/**
 * Manages throttled execution of TanStack Query refetches.
 * Includes "Leading Edge" (first call is instant) and "Trailing Edge" (guaranteed final execution).
 */
export class QueryThrottler {
    private pendingUpdates = new Map<string, { timer: any; execute: () => void }>()
    private lastExecutionTimes = new Map<string, number>()
    private defaultInterval = 20000 // 20 seconds

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
            this.queryClient.refetchQueries({ queryKey })
            this.lastExecutionTimes.set(keyString, Date.now())
            this.clearTimer(keyString)
        }

        // Outside of scan mode: Execute immediately (or with a very short debounce)
        if (!shouldThrottle) {
            // Clear any pending throttled updates since we're switching to "instant" mode
            this.clearTimer(keyString)
            execute()
            return
        }

        // Leading Edge: If it's the first time or the interval has passed, run immediately
        if (now - lastTime > this.defaultInterval) {
            if (!this.pendingUpdates.has(keyString)) {
                execute()
                return
            }
        }

        // Trailing Edge: Schedule or reschedule a final update
        if (this.pendingUpdates.has(keyString)) {
            // Already scheduled, let it run at its original time
            return
        }

        const delay = Math.max(0, this.defaultInterval - (now - lastTime))
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
