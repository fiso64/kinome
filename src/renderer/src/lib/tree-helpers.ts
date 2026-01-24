import type { LibraryItem, MediaFolder } from '../../../shared/types'

/**
 * Recursively finds an item in a folder tree by its ID.
 */
export function findItemInTree(node: MediaFolder | null, id: string): LibraryItem | null {
  if (!node || !node.children) return null
  if (node.id === id) {
    return node
  }
  for (const child of node.children) {
    if (child.id === id) {
      return child
    }
    if (child.type === 'folder') {
      const found = findItemInTree(child as MediaFolder, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Recursively finds the parent folder of an item by the item's ID.
 */
export function findParentOfItem(node: MediaFolder | null, id: string): MediaFolder | null {
  if (!node || !node.children) return null
  for (const child of node.children) {
    if (child.id === id) {
      return node
    }
    if (child.type === 'folder') {
      const found = findParentOfItem(child as MediaFolder, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Finds the path of folders from root to a specific item ID.
 */
export function findPathToItem(root: MediaFolder | null, id: string): MediaFolder[] {
  if (!root) return []
  const path: MediaFolder[] = []
  function find(current: MediaFolder): boolean {
    path.push(current)
    if (current.id === id) return true
    for (const child of current.children) {
      if (child.type === 'folder') {
        if (find(child as MediaFolder)) return true
      }
    }
    path.pop()
    return false
  }
  if (find(root)) {
    return path
  }
  return []
}
/**
 * Recursively searches a folder tree for an item by ID and replaces it with a new object.
 * Returns a NEW folder object with the item replaced, or the original if not found.
 */
export function replaceItemInTree<T extends MediaFolder>(root: T, id: string, newItem: LibraryItem): T {
  if (root.id === id) {
    return newItem as unknown as T
  }

  if (!root.children) return root

  const index = root.children.findIndex(c => c.id === id)
  if (index !== -1) {
    const newChildren = [...root.children]
    newChildren[index] = newItem
    return { ...root, children: newChildren }
  }

  // Recursive search
  let changed = false
  const newChildren = root.children.map(child => {
    if (child.type === 'folder') {
      const updated = replaceItemInTree(child as MediaFolder, id, newItem)
      if (updated !== child) {
        changed = true
        return updated
      }
    }
    return child
  })

  if (changed) {
    return { ...root, children: newChildren }
  }

  return root
}
