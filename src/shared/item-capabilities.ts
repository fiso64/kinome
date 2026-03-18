import type { LibraryItem } from './types'

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
