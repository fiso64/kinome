import { api } from './api'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
}

// A simple in-memory cache for fully loaded items.
const itemCache = new Map<string, LibraryItem>()

/**
 * Ensures that a given folder item has its children loaded.
 * If children are null, it fetches them from the backend.
 * @param item The folder item to check and potentially load children for.
 * @returns A promise that resolves to either the original item or a NEW reference if children were loaded.
 */
async function ensureChildrenAreLoaded(item: MediaFolder): Promise<MediaFolder> {
  if (item.children === null) {
    log(`ItemStore: Lazy-loading children for "${item.name}"...`)
    const children = await api.getChildren(item.id)

    // Create a NEW reference with children populated
    const updatedFolder: MediaFolder = {
      ...item,
      children: children ?? []
    }

    // Cache the newly loaded children so they can be individually updated later.
    for (const child of updatedFolder.children) {
      if (!itemCache.has(child.id)) {
        itemCache.set(child.id, { ...child })
      }
    }
    return updatedFolder
  }
  return item
}

/**
 * Retrieves a library item by its ID, ensuring it's fully loaded and ready for UI use.
 * This is the central function for fetching data in the renderer.
 * It caches results to avoid redundant backend calls.
 *
 * @param itemId The ID of the item to retrieve.
 * @returns A promise that resolves to a CLONED fully loaded LibraryItem, or null if not found.
 */
export async function getLoadedItem(itemId: string): Promise<LibraryItem | null> {
  // 1. Check cache first for an already processed item.
  if (itemCache.has(itemId)) {
    const cachedItem = itemCache.get(itemId)!
    log(`ItemStore: Cache HIT for "${cachedItem.name}" (${itemId})`)

    if (cachedItem.type === 'folder') {
      const foldersWithChildren = await ensureChildrenAreLoaded(cachedItem)
      // If ensureChildrenAreLoaded returned a new reference, update the cache
      if (foldersWithChildren !== cachedItem) {
        itemCache.set(itemId, foldersWithChildren)
      }
      return { ...foldersWithChildren }
    }
    return { ...cachedItem }
  }

  // 2. If not in cache, fetch the base item from the backend. This is the normal path for lazy-loading.
  log(`ItemStore: Cache MISS for item ${itemId}. Fetching from backend...`)
  const item = await api.getItemById(itemId)
  if (!item) {
    return null
  }

  // 3. If it's a folder, ensure its direct children are also loaded.
  let finalItem = item
  if (finalItem.type === 'folder') {
    finalItem = await ensureChildrenAreLoaded(finalItem)
  }

  // 4. Store the fully loaded item in the cache and return a CLONE.
  itemCache.set(itemId, finalItem)
  return { ...finalItem }
}

/**
 * Pre-populates the cache with a root item and its immediate children.
 * This is used to avoid a redundant fetch at startup.
 * @param root The shallowly-loaded root folder object from the backend.
 */
export function primeCacheWithRoot(root: MediaFolder): void {
  log(`ItemStore: Priming cache with root "${root.name}" and its ${root.children.length} children.`)
  itemCache.set(root.id, { ...root })
  if (root.children) {
    for (const child of root.children) {
      itemCache.set(child.id, { ...child })
    }
  }
}

/**
 * A utility to update the local cache when an item is changed elsewhere
 * (e.g., after editing metadata).
 * @param updatedItem The new version of the item.
 */
export function updateCachedItem(updatedItem: LibraryItem): void {
  // If we already have this item in cache and it's a folder with children,
  // ensure we don't wipe them out if the update is shallow.
  const existing = itemCache.get(updatedItem.id)
  let itemToCache = { ...updatedItem }

  if (
    existing &&
    existing.type === 'folder' &&
    itemToCache.type === 'folder' &&
    (!itemToCache.children || itemToCache.children.length === 0) &&
    existing.children?.length > 0
  ) {
    itemToCache.children = existing.children
  }

  // We always store a CLONE to ensure no shared mutations.
  const clonedUpdate = JSON.parse(JSON.stringify(itemToCache))
  itemCache.set(updatedItem.id, clonedUpdate)

  // If the updated item is a folder and has children, we must also
  // recursively update/add those children to the cache to ensure consistency.
  if (itemToCache.type === 'folder' && Array.isArray((itemToCache as MediaFolder).children)) {
    for (const child of (itemToCache as MediaFolder).children) {
      updateCachedItem(child)
    }
  }
}

/**
 * Invalidates the entire cache. Called on a full library refresh.
 */
export function clearItemCache(): void {
  console.log('[ItemStore] Clearing item cache.')
  itemCache.clear()
}

/**
 * Checks if an item is a season folder that has not yet had its episode
 * data fetched from the API, and if so, triggers a background fetch.
 * @param item The item to check.
 */
export function triggerSeasonEpisodeFetch(item: LibraryItem): void {
  if (
    item.type === 'folder' &&
    (item.mediaType === 'season' || item.mediaType === 'tv') &&
    !item.tmdbEpisodesFetched
  ) {
    const folder = item as MediaFolder
    // physicalParentId is an optional property for virtual folders.
    // We check it using a safe cast since we know it's a folder.
    const physicalParentId = (folder as any).physicalParentId as string | undefined

    // If it's a virtual folder, we trigger the fetch on its real parent.
    const idToFetch = folder.path.startsWith('virtual://') && physicalParentId
      ? physicalParentId
      : folder.id

    // This is a fire-and-forget call. The UI will update reactively
    // when the library-item-updated event is received.
    api.getItemDetails(idToFetch)
  }
}
