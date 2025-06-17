import type { Database, LibraryItem, MediaFolder } from './types'

// This will eventually hold our flat list of searchable items.
let searchIndex: LibraryItem[] = []

/**
 * Adds or updates an item in the search index array.
 * @param item The item to add or update.
 */
function _updateOrAddItemToIndex(item: LibraryItem) {
  const index = searchIndex.findIndex((i) => i.id === item.id)
  if (index !== -1) {
    searchIndex[index] = item // Update existing item
  } else {
    searchIndex.push(item) // Add new item
  }
}

/**
 * Removes an item from the search index array if it exists.
 * @param item The item to remove.
 */
function _removeItemFromIndex(item: LibraryItem) {
  const index = searchIndex.findIndex((i) => i.id === item.id)
  if (index !== -1) {
    searchIndex.splice(index, 1)
  }
}

/**
 * Evaluates a single item and decides whether to add, update, or remove it
 * from the search index. This will be the home for inclusion/exclusion logic.
 * @param item The LibraryItem to process.
 */
export function updateIndexForItem(item: LibraryItem) {
  // --- Future-proof place for exclusion rules ---
  // Example: if (item.path.includes('/extras/')) {
  //   _removeItemFromIndex(item);
  //   return;
  // }

  // For now, we assume all items are searchable.
  console.log(
    `[Search Index] Incrementally updating index for: "${item.title ?? item.name}" (ID: ${item.id})`
  )
  _updateOrAddItemToIndex(item)
}

/**
 * This is the generic handler called by the proxy on any data change.
 * @param target The raw object that was modified.
 * @param isBulkUpdate A flag to disable indexing during bulk operations.
 */
function onObjectChange(target: object, isBulkUpdate: boolean) {
  if (isBulkUpdate) {
    return
  }

  // We only care about changes on LibraryItems.
  if (
    !Object.prototype.hasOwnProperty.call(target, 'id') ||
    !Object.prototype.hasOwnProperty.call(target, 'type')
  ) {
    return
  }

  // The target of the `set` operation is the object that was changed.
  updateIndexForItem(target as LibraryItem)
}

// A WeakMap caches proxies, preventing re-proxying of the same object and
// handling circular references gracefully.
const proxyCache = new WeakMap()

/**
 * Creates a handler for the recursive proxy.
 * @param isBulkUpdate A function that returns the current bulk update status.
 */
function createProxyHandler(isBulkUpdate: () => boolean): ProxyHandler<any> {
  return {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      // If the retrieved value is an object (and not null), wrap it in a proxy too.
      if (value && typeof value === 'object') {
        // Pass the same handler down to nested objects.
        return new Proxy(value, createProxyHandler(isBulkUpdate))
      }
      return value
    },
    set(target, prop, value, receiver) {
      const oldValue = Reflect.get(target, prop, receiver)
      const success = Reflect.set(target, prop, value, receiver)

      // Only trigger the change handler if the new value is different from the old one.
      if (success && value !== oldValue) {
        onObjectChange(target, isBulkUpdate())
      }

      return success
    }
  }
}

/**
 * Wraps the raw database object in a recursive Proxy.
 * @param db The raw database object.
 * @param isBulkUpdate A function that returns the current bulk update status.
 * @returns A new Proxy that wraps the database.
 */
export function createDbProxy(db: Database, isBulkUpdate: () => boolean): Database {
  // Use a WeakMap to cache the top-level proxy as well.
  if (proxyCache.has(db)) {
    return proxyCache.get(db)
  }
  const handler = createProxyHandler(isBulkUpdate)
  const proxy = new Proxy(db, handler)
  proxyCache.set(db, proxy)
  return proxy
}

/**
 * (Placeholder) Builds the entire search index from the library root.
 * This is called once when the library is first loaded or fully replaced.
 */
export function buildFullSearchIndex(root: MediaFolder | null) {
  // In a future step, this will implement the full inclusion/exclusion logic.
  // For now, this placeholder clears and rebuilds a simple index of all items.
  searchIndex = []
  console.log('[Search Index] Full search index build initiated.')
  if (root) {
    // A simple recursive function to add all items to the index.
    function addAll(item: LibraryItem) {
      searchIndex.push(item)
      if (item.type === 'folder') {
        item.children.forEach(addAll)
      }
    }
    addAll(root)
    console.log(`[Search Index] Placeholder index built with ${searchIndex.length} items.`)
  }
}
