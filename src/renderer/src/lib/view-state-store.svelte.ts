import { getContext, setContext, untrack } from 'svelte';

/**
 * View State Store (Svelte 5)
 * 
 * A centralized registry for UI state that should survive component unmounting
 * but doesn't belong in the database. 
 * 
 * Uses a hierarchical key system: "root:folder_1:row_0:scroll"
 */

class ViewStateRegistry {
    // Reactive storage for all UI states
    private states = $state<Record<string, any>>({});

    /**
     * Retrieves or initializes a reactive state fragment.
     * 
     * @param key The full hierarchical key for this state
     * @param defaults The initial values if the state doesn't exist
     * @returns A reactive proxy to the state object
     */
    public get<T extends object>(key: string, defaults: T): T {
        // We use untrack because this might be called from a $derived context 
        // (like in ScrollPersistence) and we don't want to trigger a mutation error
        // when initializing a new entry.
        return untrack(() => {
            if (!(key in this.states)) {
                console.log(`[ViewStateStore] Initializing new state for key: "${key}"`, defaults);
                this.states[key] = JSON.parse(JSON.stringify(defaults));
            }
            return this.states[key];
        });
    }

    /**
     * Specifically for scroll positions to avoid object overhead if preferred,
     * but usually get() with an object is fine.
     */
    public getScroll(key: string): { x: number; y: number } {
        return this.get(key + ':scroll', { x: 0, y: 0 });
    }

    /**
     * Clears states matching a prefix (e.g. when a folder is deleted)
     */
    public clear(prefix?: string) {
        if (!prefix) {
            console.log(`[ViewStateStore] Clearing ALL states.`);
            // In Svelte 5, resetting the whole object triggers reactivity for all keys
            this.states = {};
            return;
        }

        console.log(`[ViewStateStore] Clearing states starting with: "${prefix}"`);
        for (const key in this.states) {
            if (key.startsWith(prefix)) {
                delete this.states[key];
            }
        }
    }

    // --- Re-implementing Tab Navigation Intent ---
    private _intent = $state<{ targetShowId: string; targetSeasonNumber: number } | null>(null);

    get tabNavigationIntent() { return this._intent; }
    set tabNavigationIntent(val) {
        console.log(`[ViewStateStore] Setting navigation intent:`, val);
        this._intent = val;
    }
}

export const viewStateStore = new ViewStateRegistry();

/**
 * Contextual Key Helper
 * Functions to handle the Svelte Context pathing
 */
const CONTEXT_KEY = 'kinome:view-path';

export function initViewContext(id: string) {
    const path = [id];
    setContext(CONTEXT_KEY, path);
    return path;
}

export function extendViewContext(id: string) {
    const parentPath = getContext<string[]>(CONTEXT_KEY) || ['root'];
    const newPath = [...parentPath, id];
    setContext(CONTEXT_KEY, newPath);
    return newPath;
}

export function getViewKey(suffix: string): string {
    const path = getContext<string[]>(CONTEXT_KEY) || ['root'];
    return `${path.join(':')}:${suffix}`;
}
