import { QueryClient, createQuery } from '@tanstack/svelte-query'
import { QueryThrottler } from '@lib/query-throttler'
import { api } from '@lib/api'
import type { LibraryItem } from '@shared/types'

/**
 * LibraryDataService: The authoritative "Middle Man" for all library-related data.
 *
 * DESIGN PRINCIPLES:
 * 1. ENCAPSULATION: This service owns the "root vs UUID" normalization logic.
 * 2. POLICY: This service owns the synchronization strategy (Surgical Patch + Throttled Sync).
 * 3. SCOPE: ONLY library metadata, hierarchy, and sync logic.
 *    - "Metadata" includes per-item configurations (view settings, folder settings).
 *    - DO NOT add Playback logic.
 *    - DO NOT add Global App Settings (Theme, Auth, Scan Preferences).
 *    - DO NOT add App Lifecycle/Shell logic.
 *
 * This prevents the service from becoming a "God Service" while ensuring
 * 100% robust data handling across the app.
 */
class LibraryDataService {
  private queryClient: QueryClient | null = null
  private throttler: QueryThrottler | null = null

  // State using Svelte 5 runes
  rootId = $state<string | null>(null)

  // Internal Query Key Templates (Private implementation detail)
  private readonly keys = {
    item: {
      all: ['item'] as const,
      details: (id: string | null | undefined) => [...this.keys.item.all, id, 'details'] as const,
      tree: (id: string | null | undefined) => [...this.keys.item.all, id, 'tree'] as const
    },
    children: {
      all: ['children'] as const,
      byParent: (
        parentId: string | null | undefined,
        fields: string[] = [],
        groupBy?: string,
        isDetailView: boolean = false
      ) => [...this.keys.children.all, parentId, { fields, groupBy, isDetailView }] as const
    },
    continueWatching: {
      all: ['continue-watching'] as const,
      forShow: (showId: string | null | undefined) =>
        [...this.keys.continueWatching.all, showId] as const
    },
    parent: {
      byItem: (itemId: string | null | undefined) => ['parent', itemId] as const
    }
  }

  /**
   * Initializes the service with the app's QueryClient.
   * This should be called once in App.svelte or main.ts.
   */
  init(queryClient?: QueryClient): QueryClient {
    this.queryClient =
      queryClient ||
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes defaults
            retry: 1
          }
        }
      })
    this.throttler = new QueryThrottler(this.queryClient)
    return this.queryClient
  }

  // --- 1. Normalization Logic ---

  /**
   * Maps a backend UUID to the frontend 'root' alias if it matches the current root.
   */
  normalizeId(id: string | null | undefined): string | null | undefined {
    if (!id) return id
    if (this.rootId && id === this.rootId) return 'root'
    return id
  }

  /**
   * Robustly compares two IDs by normalizing them first.
   */
  isIdMatch(id1: string | null | undefined, id2: string | null | undefined): boolean {
    return this.normalizeId(id1) === this.normalizeId(id2)
  }

  // --- 2. Query Factories (Component API) ---

  /**
   * Returns a query for item details (metadata).
   */
  getItemDetailsQuery(
    idFn: () => string | null | undefined,
    options: { fields?: () => string[]; enabled?: () => boolean } = {}
  ) {
    return createQuery(() => {
      const id = idFn()
      const normalizedId = this.normalizeId(id)
      const fields = (options.fields ? options.fields() : []).sort()
      const isEnabled = options.enabled ? options.enabled() : true

      return {
        queryKey: [...this.keys.item.details(normalizedId), { fields }],
        queryFn: () => (normalizedId ? api.getItemDetails(id!, fields) : null),
        enabled: isEnabled && !!normalizedId
      }
    })
  }

  /**
   * Imperatively fetches item details using the query cache.
   * This is useful for lazy loading in event handlers.
   */
  async fetchItemDetails(id: string, fields: string[] = []): Promise<LibraryItem | null> {
    if (!this.queryClient) return null
    const normalizedId = this.normalizeId(id)
    if (!normalizedId) return null

    const sortedFields = [...fields].sort()
    return this.queryClient.fetchQuery({
      queryKey: [...this.keys.item.details(normalizedId), { fields: sortedFields }],
      queryFn: () => api.getItemDetails(id, sortedFields)
    })
  }

  /**
   * Returns a query for an item tree (Details / Sidebar).
   */
  getItemTreeQuery(
    idFn: () => string | null | undefined,
    options: { fields?: () => string[]; enabled?: () => boolean } = {}
  ) {
    return createQuery(() => {
      const id = idFn()
      const normalizedId = this.normalizeId(id)
      const fields = (options.fields ? options.fields() : []).sort()
      const isEnabled = options.enabled ? options.enabled() : true

      return {
        queryKey: this.keys.item.tree(normalizedId),
        queryFn: () => (normalizedId ? api.getItemV2(id!, ['tree', ...fields]) : null),
        enabled: isEnabled && !!normalizedId
      }
    })
  }

  /**
   * Returns a query for children items (Main List View).
   */
  getChildrenQuery(
    parentIdFn: () => string | null | undefined,
    options: {
      fields?: () => string[]
      groupBy?: () => string | undefined
      isDetailView?: () => boolean
      enabled?: () => boolean
    } = {}
  ) {
    return createQuery(() => {
      const parentId = parentIdFn()
      const normalizedId = this.normalizeId(parentId)
      const fields = (options.fields ? options.fields() : []).sort()
      const groupBy = options.groupBy ? options.groupBy() : undefined
      const isDetailView = options.isDetailView ? options.isDetailView() : false
      const isEnabled = options.enabled ? options.enabled() : true

      return {
        queryKey: this.keys.children.byParent(normalizedId, fields, groupBy, isDetailView),
        queryFn: () =>
          normalizedId
            ? api.getChildren(parentId!, {
              fields,
              isDetailView
            })
            : [],
        enabled: isEnabled && normalizedId !== undefined && normalizedId !== null
      }
    })
  }

  /**
   * Returns a query for the "Continue Watching" list.
   */
  getContinueWatchingQuery(options: { enabled?: () => boolean } = {}) {
    return createQuery(() => {
      const isEnabled = options.enabled ? options.enabled() : true
      return {
        queryKey: this.keys.continueWatching.all,
        queryFn: async () => {
          return await api.getContinueWatchingItems()
        },
        enabled: isEnabled
      }
    })
  }

  /**
   * Returns a query for show-specific "Continue Watching" (Next Up) info.
   */
  getContinueWatchingForShowQuery(
    showIdFn: () => string | null | undefined,
    options: { enabled?: () => boolean } = {}
  ) {
    return createQuery(() => {
      const showId = showIdFn()
      const isEnabled = options.enabled ? options.enabled() : true
      return {
        queryKey: this.keys.continueWatching.forShow(showId),
        queryFn: () => (showId ? api.getContinueWatchingForShow(showId) : null),
        enabled: isEnabled && !!showId
      }
    })
  }

  /**
   * Returns a query for an item's parent.
   */
  getParentQuery(
    itemIdFn: () => string | null | undefined,
    options: { enabled?: () => boolean } = {}
  ) {
    return createQuery(() => {
      const itemId = itemIdFn()
      const isEnabled = options.enabled ? options.enabled() : true
      return {
        queryKey: this.keys.parent.byItem(itemId),
        queryFn: () => (itemId ? api.getParent(itemId) : null),
        enabled: isEnabled && !!itemId
      }
    })
  }

  // --- 3. Synchronization Policy (The "Double-Tap") ---

  /**
   * Processes a batch of item updates from the backend.
   */
  handleLibraryUpdates(updatedItems: LibraryItem[], isScanning: boolean) {
    if (!this.queryClient || !this.throttler) return

    const ancestorIdsToRefetch = new Set<string>()
    let refreshGlobalContinueWatching = false
    const showIdsForCWRefetch = new Set<string>()

    for (const item of updatedItems) {
      // Step A: Surgical Patch (Instant & Silent - 0ms feedback)
      const normalizedId = this.normalizeId(item.id)

      // 1. Update the item itself wherever it appears as a primary entity (Details, Tree, Settings)
      this.queryClient.setQueriesData(
        { queryKey: [...this.keys.item.all, normalizedId] },
        (old: any) => (old ? { ...old, ...item } : old)
      )

      // 2. Patch any active children lists where this item might be a member.
      this.queryClient.setQueriesData({ queryKey: this.keys.children.all }, (oldData: any) => {
        if (!Array.isArray(oldData)) return oldData
        const index = oldData.findIndex((i: LibraryItem) => i.id === item.id)
        if (index !== -1) {
          const newData = [...oldData]
          newData[index] = { ...oldData[index], ...item }
          return newData
        }
        return oldData
      })

      // Step B: Collect for Structural Sync
      if (item.ancestorIds && item.ancestorIds.length > 0) {
        for (const ancestorId of item.ancestorIds) {
          ancestorIdsToRefetch.add(ancestorId)
        }
      }

      const isCWRelated =
        (item.type === 'file' && 'watched' in item) ||
        (item.type === 'folder' &&
          ('continueWatchingDismissed' in item || 'nextUpDismissed' in item))

      if (isCWRelated) {
        refreshGlobalContinueWatching = true
        // If it's a TV related item, we might need to refresh show-specific CW
        if (item.ancestorIds) {
          for (const ancestorId of item.ancestorIds) {
            // We don't know for sure which ancestor is the show, so we refetch for all ancestors
            // that have an active CW query. throttling handles the overhead.
            showIdsForCWRefetch.add(ancestorId)
          }
        }
      }
    }

    // Step C: Execute Throttled Sync (Structural Truth)

    // IMPORTANT NOTE: Invalidating ALL active children queries is potentially expensive,
    // but it ensures 100% structural robustness (sorting, grouping, virtual moves).
    // We haven't experienced performance problems with this YET...
    this.throttler.throttleRefetch(this.keys.children.all, isScanning)

    ancestorIdsToRefetch.forEach((ancestorId) => {
      const normalizedAncestorId = this.normalizeId(ancestorId)
      this.throttler!.throttleRefetch(this.keys.item.tree(normalizedAncestorId), isScanning)
    })

    if (refreshGlobalContinueWatching) {
      this.throttler.throttleRefetch(this.keys.continueWatching.all, isScanning)
    }

    showIdsForCWRefetch.forEach((showId) => {
      this.throttler!.throttleRefetch(this.keys.continueWatching.forShow(showId), isScanning)
    })
  }

  /**
   * Processes an item deletion from the backend.
   */
  handleLibraryDeletion(deletedItemId: string) {
    if (!this.queryClient) return
    const normalizedId = this.normalizeId(deletedItemId)

    // 1. Invalidate item queries
    this.queryClient.invalidateQueries({ queryKey: [...this.keys.item.all, normalizedId] })

    // 2. Invalidate all children lists (structural sync)
    this.queryClient.invalidateQueries({ queryKey: this.keys.children.all })
  }

  /**
   * Globally invalidates all library-related queries.
   * Useful for manual refreshes or after significant settings changes.
   */
  invalidateAllQueries() {
    if (!this.queryClient) return
    this.queryClient.invalidateQueries({ queryKey: this.keys.item.all })
    this.queryClient.invalidateQueries({ queryKey: this.keys.children.all })
    this.queryClient.invalidateQueries({ queryKey: this.keys.continueWatching.all })
  }

  /**
   * Performs an optimistic update to remove a dismissal show from the Continue Watching list.
   */
  optimisticDismissContinueWatching(showId: string) {
    if (!this.queryClient) return
    this.queryClient.setQueryData(this.keys.continueWatching.all, (old: any) => {
      if (!Array.isArray(old)) return old
      return old.filter((item: any) => item.show?.id !== showId)
    })
  }

  /**
   * Forces a flush of all pending throttled updates (e.g. when a scan finishes).
   */
  flush() {
    this.throttler?.flush()
  }
}

export const libraryDataService = new LibraryDataService()
