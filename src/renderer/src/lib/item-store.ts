const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Renderer] ${message}`)
}

// A simple in-memory cache for fully loaded items.
const itemCache = new Map<string, LibraryItem>()

/**
 * Ensures that a given folder item has its children loaded.
 * If children are null, it fetches them from the backend.
 * This function MUTATES the item object passed to it.
 * @param item The folder item to check and potentially load children for.
 * @returns The same folder item, with its children array guaranteed to be populated.
 */
async function ensureChildrenAreLoaded(item: MediaFolder): Promise<MediaFolder> {
  if (item.children === null) {
    log(`ItemStore: Lazy-loading children for "${item.name}"...`)
    const children = await window.api.getChildren(item.id)
    item.children = children ?? []
  }
  return item
}

/**
 * Retrieves a library item by its ID, ensuring it's fully loaded and ready for UI use.
 * This is the central function for fetching data in the renderer.
 * It caches results to avoid redundant backend calls.
 *
 * @param itemId The ID of the item to retrieve.
 * @returns A promise that resolves to the fully loaded LibraryItem, or null if not found.
 */
export async function getLoadedItem(itemId: string): Promise<LibraryItem | null> {
  // 1. Check cache first for an already processed item.
  if (itemCache.has(itemId)) {
    const cachedItem = itemCache.get(itemId)!
    log(`ItemStore: Cache HIT for "${cachedItem.name}" (${itemId})`)
    // This is a crucial check: a folder can be in the cache but with unloaded children.
    // We must ensure they are loaded before returning the item.
    if (cachedItem.type === 'folder') {
      await ensureChildrenAreLoaded(cachedItem)
    }
    return cachedItem
  }

  // 2. If not in cache, fetch the base item from the backend. This is the normal path for lazy-loading.
  log(`ItemStore: Cache MISS for item ${itemId}. Fetching from backend...`)
  const item = await window.api.getItemById(itemId)
  if (!item) {
    return null
  }

  // 3. If it's a folder, ensure its direct children are also loaded.
  if (item.type === 'folder') {
    await ensureChildrenAreLoaded(item)
  }

  // 4. Store the fully loaded item in the cache and return it.
  itemCache.set(itemId, item)
  return item
}

/**
 * Pre-populates the cache with a root item and its immediate children.
 * This is used to avoid a redundant fetch at startup.
 * @param root The shallowly-loaded root folder object from the backend.
 */
export function primeCacheWithRoot(root: MediaFolder): void {
  log(`ItemStore: Priming cache with root "${root.name}" and its ${root.children.length} children.`)
  itemCache.set(root.id, root)
  if (root.children) {
    for (const child of root.children) {
      itemCache.set(child.id, child)
    }
  }
}

/**
 * A utility to update the local cache when an item is changed elsewhere
 * (e.g., after editing metadata).
 * @param updatedItem The new version of the item.
 */
export function updateCachedItem(updatedItem: LibraryItem): void {
  // We only update if the item is already in the cache.
  if (itemCache.has(updatedItem.id)) {
    const cachedItem = itemCache.get(updatedItem.id)!
    // Preserve the children array from the cached version, as the updatedItem
    // from the metadata editor might not have it.
    const children = cachedItem.type === 'folder' ? cachedItem.children : undefined
    Object.assign(cachedItem, updatedItem)
    if (children && cachedItem.type === 'folder') {
      cachedItem.children = children
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
