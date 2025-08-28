import path from 'path'
import fs from 'fs/promises'
import { type Dirent } from 'fs'
import * as pathsService from './paths.service'
import { generateId } from './repository.service'
import type { LibraryItem, MediaFolder } from '../../shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [Filesystem Service] ${message}`)
}

export async function syncWithDisk(node: MediaFolder, mediaSourcePath: string): Promise<void> {
  const nodeAbsolutePath = path.join(mediaSourcePath, node.path)
  let diskChildEntries: Dirent[]
  try {
    await fs.access(nodeAbsolutePath)
    diskChildEntries = await fs.readdir(nodeAbsolutePath, { withFileTypes: true })
    if (diskChildEntries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
      log(`Ignoring directory due to .ignore file: ${nodeAbsolutePath}`)
      if (node.isUserEdited) {
        const hideRecursively = (item: LibraryItem) => {
          item.isHidden = true
          item.isMissing = undefined
          if (item.type === 'folder') item.children.forEach(hideRecursively)
        }
        hideRecursively(node)
      } else {
        node.isMissing = true
        const markAllChildrenMissing = (folder: MediaFolder) => {
          if (!folder.children) return
          folder.children.forEach((child) => {
            child.isMissing = true
            if (child.type === 'folder') markAllChildrenMissing(child)
          })
        }
        markAllChildrenMissing(node)
      }
      return
    }
    if (node.isHidden) {
      const unhideRecursively = (item: LibraryItem) => {
        item.isHidden = undefined
        if (item.type === 'folder') item.children.forEach(unhideRecursively)
      }
      unhideRecursively(node)
    }
    node.isMissing = undefined
  } catch (e) {
    node.isMissing = true
    const markAllChildrenMissing = (folder: MediaFolder) => {
      if (!folder.children) return
      folder.children.forEach((child) => {
        child.isMissing = true
        if (child.type === 'folder') markAllChildrenMissing(child)
      })
    }
    markAllChildrenMissing(node)
    return
  }
  const dbChildrenMap = new Map(node.children.map((child) => [child.name, child]))
  const diskChildrenNames = new Set(diskChildEntries.map((e) => e.name))
  for (const entry of diskChildEntries) {
    if (!dbChildrenMap.has(entry.name)) {
      const isVideoFile = entry.isFile() && /\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)
      if (entry.isDirectory() || isVideoFile) {
        const childRelativePath = path.join(node.path, entry.name).replace(/\\/g, '/')
        const newChild: LibraryItem = {
          id: generateId(childRelativePath),
          name: entry.name,
          path: childRelativePath,
          type: entry.isDirectory() ? 'folder' : 'file',
          ...(entry.isDirectory() && { children: [] })
        } as any
        node.children.push(newChild)
      }
    }
  }
  for (const child of node.children) {
    if (diskChildrenNames.has(child.name)) {
      child.isMissing = undefined
      if (child.type === 'folder') await syncWithDisk(child, mediaSourcePath)
    } else {
      child.isMissing = true
      if (child.type === 'folder') {
        const markDescendantsMissing = (folder: MediaFolder) => {
          if (!folder.children) return
          folder.children.forEach((c) => {
            c.isMissing = true
            if (c.type === 'folder') markDescendantsMissing(c)
          })
        }
        markDescendantsMissing(child)
      }
    }
  }
}

export function pruneUntouchedMissingItems(node: MediaFolder) {
  if (!node.children) return
  if (node.isMissing) {
    for (const child of node.children) {
      if (child.type === 'folder') pruneUntouchedMissingItems(child)
    }
    return
  }
  node.children = node.children.filter((child) => !(child.isMissing && !child.isUserEdited))
  for (const child of node.children) {
    if (child.type === 'folder') pruneUntouchedMissingItems(child)
  }
}

export async function verifyImagePaths(item: LibraryItem, imagesDir: string) {
  if (pathsService.isRemoteLibrary()) return
  if (item.posterPath) {
    try {
      await fs.access(path.join(imagesDir, item.posterPath))
    } catch {
      log(`Poster for "${item.name}" not found. Marking for re-download.`)
      item.posterPath = undefined
    }
  }
  if (item.backdropPath) {
    try {
      await fs.access(path.join(imagesDir, item.backdropPath))
    } catch {
      log(`Backdrop for "${item.name}" not found. Marking for re-download.`)
      item.backdropPath = undefined
    }
  }
  if (item.logoPath) {
    try {
      await fs.access(path.join(imagesDir, item.logoPath))
    } catch {
      log(`Logo for "${item.name}" not found. Marking for re-download.`)
      item.logoPath = undefined
    }
  }
}

export async function scanDirectory(
  dirPath: string,
  rootPath: string
): Promise<MediaFolder | null> {
  const name = path.basename(dirPath)
  const children: LibraryItem[] = []
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  if (entries.some((entry) => entry.name === '.ignore' && entry.isFile())) {
    log(`Ignoring directory due to .ignore file: ${dirPath}`)
    return null
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    const entryRelativePath = path.relative(rootPath, entryPath).replace(/\\/g, '/')
    if (entry.isDirectory()) {
      const subFolder = await scanDirectory(entryPath, rootPath)
      if (subFolder) children.push(subFolder)
    } else if (entry.isFile()) {
      if (/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i.test(entry.name)) {
        children.push({
          id: generateId(entryRelativePath),
          name: entry.name,
          path: entryRelativePath,
          type: 'file'
        })
      }
    }
  }
  if (children.length === 0) return null
  const relativePath = path.relative(rootPath, dirPath).replace(/\\/g, '/')
  return {
    id: generateId(relativePath || '.'),
    name: name || path.basename(rootPath),
    path: relativePath || '.',
    type: 'folder',
    children
  }
}