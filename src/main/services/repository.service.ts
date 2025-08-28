import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import * as virtualTagsService from './virtualTags.service'
import * as searchService from './search.service'
import * as settingsService from './settings.service'
import * as pathsService from './paths.service'
import type { Database, LibraryItem, MediaFolder, Settings } from '../../shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Repository Service] ${message}`)
}

const DATABASE_FILE_NAME = 'database.json'
const DB_VERSION = 1

// --- In-Memory Database Cache ---
let db: Database | null = null
let isBulkUpdating = false

export const getBulkUpdateStatus = (): boolean => isBulkUpdating
export const setBulkUpdateStatus = (status: boolean): void => {
  isBulkUpdating = status
  log(`Bulk update mode: ${status ? 'ON' : 'OFF'}`)
}

// --- Read/Write Operations ---

function getDbPath(): string {
  return pathsService.resolveLibraryPath(DATABASE_FILE_NAME)
}

async function readDbFromFile(): Promise<Database | null> {
  try {
    const dbPath = getDbPath()
    let data: string
    if (pathsService.isRemoteLibrary()) {
      log(`Fetching remote database from: ${dbPath}`)
      const response = await fetch(dbPath)
      if (!response.ok) {
        if (response.status !== 404) {
          console.warn(`Failed to fetch ${dbPath}: ${response.statusText}`)
        }
        return null
      }
      data = await response.text()
    } else {
      data = await fs.readFile(dbPath, 'utf-8')
    }

    const parsedDb = JSON.parse(data) as Database
    if (parsedDb.version !== DB_VERSION) {
      console.warn(
        `Database version mismatch. Expected ${DB_VERSION}, got ${parsedDb.version}. Ignoring old DB.`
      )
      return null
    }
    return parsedDb
  } catch (e) {
    console.error(`Failed to read or parse database from ${getDbPath()}:`, e)
    return null
  }
}

export async function writeDb(): Promise<void> {
  if (!db) return
  if (pathsService.isRemoteLibrary()) {
    log('Write operations are disabled for remote libraries.')
    return
  }

  const libraryPath = pathsService.getLibraryDataPath()
  await fs.mkdir(libraryPath, { recursive: true })
  const dbPath = getDbPath()

  const replacer = (key: string, value: unknown) => {
    if (key === 'virtualTags') return undefined
    return value
  }

  await fs.writeFile(dbPath, JSON.stringify(db, replacer, 2))
}

export async function createNewDb(rootNode: MediaFolder | null): Promise<void> {
  const settings = await settingsService.readSettings()
  setBulkUpdateStatus(true)
  const newDb: Database = { version: DB_VERSION, root: rootNode }
  if (rootNode) {
    applyVirtualTagsToAllItems(rootNode, settings)
  }
  // This replaces the old db instance.
  db = newDb
  searchService.buildFullSearchIndex(db.root)
  setBulkUpdateStatus(false)
  await writeDb()
}

// --- DB Initialization ---

/**
 * Recursively traverses the library tree and applies virtual tags to each item.
 * This function MUTATES the items in place.
 */
function applyVirtualTagsToAllItems(node: LibraryItem, settings: Settings) {
  node.virtualTags = virtualTagsService.evaluateVirtualTagsForItem(node, settings)
  if (node.type === 'folder') {
    for (const child of node.children) {
      applyVirtualTagsToAllItems(child, settings)
    }
  }
}

export async function loadDb(): Promise<void> {
  log('Attempting to load database from disk...')
  const rawDb = await readDbFromFile()

  if (rawDb) {
    log('Database file found. Processing...')
    setBulkUpdateStatus(true)
    if (rawDb.root) {
      const settings = await settingsService.readSettings()
      applyVirtualTagsToAllItems(rawDb.root, settings)
    }
    db = rawDb
    searchService.buildFullSearchIndex(db.root)
    setBulkUpdateStatus(false)
    log('Finished loading DB into memory.')
  } else {
    log('No database file found or DB is invalid.')
    db = null
    searchService.buildFullSearchIndex(null)
  }
}

// --- Read Queries ---

export function getRoot(): MediaFolder | null {
  return db?.root ?? null
}

function _findItemById(id: string, node: MediaFolder): LibraryItem | null {
  if (node.id === id) return node
  for (const child of node.children) {
    if (child.id === id) return child
    if (child.type === 'folder') {
      const found = _findItemById(id, child)
      if (found) return found
    }
  }
  return null
}

export function getItemById(id: string): LibraryItem | null {
  if (!db?.root) return null
  return _findItemById(id, db.root)
}

function _findParent(id: string, node: MediaFolder): MediaFolder | null {
  if (!node || !node.children) return null
  for (const child of node.children) {
    if (child.id === id) return node
    if (child.type === 'folder') {
      const found = _findParent(id, child)
      if (found) return found
    }
  }
  return null
}

export function findParent(id: string): MediaFolder | null {
  if (!db?.root) return null
  return _findParent(id, db.root)
}

function _getAllItemsAsList(node: MediaFolder, list: LibraryItem[] = []): LibraryItem[] {
  list.push(node)
  for (const child of node.children) {
    if (child.type === 'folder') {
      _getAllItemsAsList(child, list)
    } else {
      list.push(child)
    }
  }
  return list
}

export function getAllItemsAsList(): LibraryItem[] {
  if (!db?.root) return []
  return _getAllItemsAsList(db.root)
}

export function getAllDescendantsAsList(node: MediaFolder): LibraryItem[] {
  return _getAllItemsAsList(node, [])
}

function _findItemByPath(p: string, node: MediaFolder): LibraryItem | null {
  if (node.path === p) return node
  if (!node.children) return null
  for (const child of node.children) {
    if (child.path === p) return child
    if (child.type === 'folder') {
      const found = _findItemByPath(p, child)
      if (found) return found
    }
  }
  return null
}

export function findItemByPath(p: string): LibraryItem | null {
  if (!db?.root) return null
  return _findItemByPath(p, db.root)
}

// --- Write Operations ---

export function markAsUserEdited(itemId: string): LibraryItem[] {
  if (!db?.root) return []
  const modifiedItems: LibraryItem[] = []
  const item = getItemById(itemId)
  if (item) {
    if (!item.isUserEdited) {
      item.isUserEdited = true
      modifiedItems.push(item)
    }
    let parent = findParent(item.id)
    while (parent) {
      if (!parent.isUserEdited) {
        parent.isUserEdited = true
        modifiedItems.push(parent)
      }
      parent = findParent(parent.id)
    }
  }
  return modifiedItems
}

/**
 * Low-level item update. This function directly mutates the item in the database.
 * It is the responsibility of the CALLER to handle side effects like updating virtual
 * tags, updating the search index, and notifying the transport layer.
 * @param itemId The ID of the item to update.
 * @param updates A partial object of properties to update.
 * @returns The updated item, or null if not found.
 */
export function updateItem(itemId: string, updates: Partial<LibraryItem>): LibraryItem | null {
  if (!db?.root) return null
  const itemInDb = getItemById(itemId)
  if (itemInDb) {
    // These properties should never be updated via this method.
    delete (updates as Partial<MediaFolder>).children
    delete (updates as Partial<LibraryItem>).id
    delete (updates as Partial<LibraryItem>).path
    delete (updates as Partial<LibraryItem>).type
    Object.assign(itemInDb, updates)
    return itemInDb
  }
  return null
}

export function deleteItem(itemId: string): LibraryItem | null {
  if (!db?.root) return null
  const parent = findParent(itemId)
  if (!parent) return null
  const itemIndex = parent.children.findIndex((c) => c.id === itemId)
  if (itemIndex === -1) return null
  const [itemToDelete] = parent.children.splice(itemIndex, 1)
  return itemToDelete
}

export function generateId(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex')
}

// --- Utilities ---

/**
 * Creates a deep, transferable copy of a library item suitable for sending over IPC.
 * It removes proxies, filters hidden children, and prunes grandchildren to keep the payload small.
 * @param item The library item to copy.
 * @returns A plain JavaScript object copy of the item.
 */
export function createTransferableCopy(item: LibraryItem): LibraryItem {
  // Deep clone to create a plain object free of proxies for IPC.
  const plainItem = JSON.parse(JSON.stringify(item))

  if (plainItem.type === 'folder' && Array.isArray(plainItem.children)) {
    plainItem.children = plainItem.children
      .filter((child: LibraryItem) => !child.isHidden)
      .map((child: LibraryItem) => {
        if (child.type === 'folder') {
          // Create a new object that conforms to the MediaFolder shape but with empty children
          // to prevent sending the entire subtree over IPC. The client will lazy-load them.
          return { ...child, children: [] }
        }
        return child
      })
  }
  return plainItem
}

/**
 * Creates a deeper, transferable copy of a library item specifically for the detail view.
 * It preserves descendants, which is necessary for tabbed/sectioned views within the detail page.
 * @param item The library item to copy.
 * @returns A plain JavaScript object copy of the item with one extra level of children.
 */
export function createForDetailViewCopy(item: LibraryItem): LibraryItem {
  // 1. Start with a full deep clone to get a clean object.
  const plainItem = JSON.parse(JSON.stringify(item));

  if (plainItem.type === 'folder' && Array.isArray(plainItem.children)) {
    // 2. Filter any hidden direct children (e.g., hidden seasons).
    plainItem.children = plainItem.children.filter((child: LibraryItem) => !child.isHidden);

    // 3. For each direct child that is a folder (e.g., a season), ensure its own
    //    children (the episodes) are filtered...
    for (const child of plainItem.children) {
      if (child.type === 'folder' && Array.isArray(child.children)) {
        child.children = child.children.filter((grandchild: LibraryItem) => !grandchild.isHidden);
        // ...but we do NOT prune the great-grandchildren here.
      }
    }
  }
  return plainItem;
}