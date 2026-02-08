import { viewStateStore } from './view-state-store.svelte'

export interface ScrollPersistenceOptions {
    key: string
    resetOn?: any
    disabled?: boolean
    onRestore?: (y: number, x: number) => void
}

/**
 * Svelte 5 Action for Scroll Persistence
 *
 * Usage: <div class="scroller" use:scrollPersistence={{ key: 'view-id' }}>
 */
export function scrollPersistence(node: HTMLElement, options: ScrollPersistenceOptions) {
    let isRestoring = false
    let lastScrollHeight = 0

    function getStore() {
        // Ensure defaults include resetVal
        return viewStateStore.get(options.key, { y: 0, x: 0, resetVal: null as string | null })
    }

    // --- Initial Reset Check ---
    // If the Reset Value stored in the global state differs from the current props, 
    // it means the context changed while this component was unmounted/inactive.
    // We must reset the scroll position.
    if (!options.disabled && options.resetOn !== undefined) {
        const currentVal = JSON.stringify(options.resetOn)
        const store = getStore()

        console.log(`[ScrollPersistence:${options.key}] INIT CHECK | Store: '${store.resetVal}' | Current: '${currentVal}'`)

        // If stored value exists and differs from current, RESET.
        if (store.resetVal !== null && store.resetVal !== currentVal) {
            console.log(`[ScrollPersistence:${options.key}] RESET (INIT) - MISMATCH`)
            store.y = 0
            store.x = 0
            store.resetVal = currentVal
            node.scrollTo({ top: 0, left: 0, behavior: 'instant' })
        } else if (store.resetVal === null) {
            // First run, or stale state without resetVal. 
            // We verify y/x are 0 just in case.
            if (store.y !== 0 || store.x !== 0) {
                console.log(`[ScrollPersistence:${options.key}] RESET (INIT) - CLEANUP STALE STATE`)
                store.y = 0
                store.x = 0
            }
            store.resetVal = currentVal
        }
    }

    function handleScroll() {
        if (isRestoring || options.disabled) return

        // Ignore resets to 0 if the container isn't scrollable (likely a layout shift/unmount)
        if (
            node.scrollTop === 0 &&
            node.scrollLeft === 0 &&
            node.scrollHeight <= node.clientHeight
        ) {
            return
        }

        const store = getStore()
        // Performance optimization: only update store if changed significantly
        if (Math.abs(store.y - node.scrollTop) > 1 || Math.abs(store.x - node.scrollLeft) > 1) {
            store.y = node.scrollTop
            store.x = node.scrollLeft
        }
    }

    function tryRestore() {
        if (isRestoring || options.disabled) return false

        const store = getStore()
        if (store.y === 0 && store.x === 0) return true // Nothing to restore

        const canScroll = node.scrollHeight > node.clientHeight
        if (canScroll) {
            // Don't restore if already there
            if (Math.abs(node.scrollTop - store.y) < 2 && Math.abs(node.scrollLeft - store.x) < 2) {
                return true
            }

            console.log(
                `[ScrollPersistence:${options.key}] RESTORING | y: ${store.y} | h: ${node.scrollHeight}`
            )
            isRestoring = true
            node.scrollTo({ top: store.y, left: store.x, behavior: 'instant' })

            if (options.onRestore) options.onRestore(store.y, store.x)

            // Buffer time to let the scroll event pass
            setTimeout(() => {
                isRestoring = false
            }, 100)
            return true
        }
        return false
    }

    // Monitor for content changes to trigger restoration
    const resizeObserver = new ResizeObserver(() => {
        if (node.scrollHeight !== lastScrollHeight) {
            lastScrollHeight = node.scrollHeight
            if (lastScrollHeight > node.clientHeight) {
                tryRestore()
            }
        }
    })

    node.addEventListener('scroll', handleScroll, { passive: true })
    resizeObserver.observe(node)
    // Also observe children for height changes (more granular)
    const children = Array.from(node.children)
    children.forEach((c) => resizeObserver.observe(c))

    return {
        update(newOptions: ScrollPersistenceOptions) {
            // --- Update Reset Check ---
            // Only update/reset if the view is active (not disabled).
            if (!newOptions.disabled && newOptions.resetOn !== undefined) {
                const currentVal = JSON.stringify(newOptions.resetOn)
                // Access store with potentially new key
                const store = viewStateStore.get(newOptions.key, { y: 0, x: 0, resetVal: null as string | null })

                if (store.resetVal !== currentVal) {
                    console.log(`[ScrollPersistence:${newOptions.key}] RESET (UPDATE) | Store: '${store.resetVal}' => Current: '${currentVal}'`)
                    store.y = 0
                    store.x = 0
                    store.resetVal = currentVal
                    node.scrollTo({ top: 0, left: 0, behavior: 'instant' })
                }
            }

            options = newOptions
            tryRestore()
        },
        destroy() {
            node.removeEventListener('scroll', handleScroll)
            resizeObserver.disconnect()
        }
    }
}
