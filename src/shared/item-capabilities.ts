import type { LibraryItem } from './types'
import { isSupportedVideoFile } from './local-media'

/**
 * Centralized capability checks for library items.
 *
 * Every UI visibility decision based on item type/state should go through
 * this function so the rules live in one place.
 */
export function itemCapabilities(item: Pick<LibraryItem, 'type' | 'isVirtual' | 'virtualType' | 'isMissing' | 'mediaType'>) {
  const isVirtual = item.isVirtual === true
  const isFolder = item.type === 'folder'
  const isMissing = (item as any).isMissing === true

  return {
    canEditMetadata: true,
    canEditArtwork: true,
    canManualSearch: !isVirtual,
    canEditFolderSettings: isFolder && !isVirtual,
    canEditView: isFolder,
    canPlay: !isFolder && !isVirtual && !isMissing,
    canDownload: !isFolder && !isVirtual && !isMissing,
    canFilesystemOps: !isVirtual && !isMissing,
    canHide: !isVirtual,
    canDelete: (isMissing && !isVirtual) || (isVirtual && item.virtualType === 'user'),
    canAssignSeasons: isFolder && !isVirtual && item.mediaType === 'tv',
    canCreateVirtualFolder: isFolder,
    canEditVirtualFolder: isVirtual && (item.virtualType === 'user' || item.virtualType === 'home'),
    canCustomActions: !isVirtual,
  }
}

export type ItemCapabilities = ReturnType<typeof itemCapabilities>

type MovieFileCandidate = Pick<LibraryItem, 'type' | 'name' | 'mediaType' | 'isVirtual' | 'virtualType' | 'isMissing'> &
  { size?: number | null; isHidden?: boolean; isIgnored?: boolean }

/** A visible, playable video file in a movie folder. */
export function isMovieFileCandidate(child: MovieFileCandidate): boolean {
  return child.type === 'file' && !child.isHidden && !child.isIgnored && isSupportedVideoFile(child.name) && itemCapabilities(child).canPlay
}

/** The feature file of a movie folder: the largest playable video, preferring a file matched as the movie itself. */
export function selectMovieFile<T extends MovieFileCandidate>(children: Iterable<T>): T | undefined {
  let selected: T | undefined
  for (const child of children) {
    if (!isMovieFileCandidate(child)) continue
    const priority = !selected ? -1 :
      Number(selected.mediaType === 'movie') - Number(child.mediaType === 'movie') ||
      (selected.size ?? 0) - (child.size ?? 0) ||
      child.name.localeCompare(selected.name, undefined, { numeric: true })
    if (priority < 0) selected = child
  }
  return selected
}
