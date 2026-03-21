import * as metadataRepo from '../database/repositories/metadata.repo'
import type { VirtualTagConfig } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [VirtualTags] ${message}`)
}

/**
 * Applies virtual tags by evaluating SQL CASE expressions against media_entities
 * and writing results to the entity_virtual_tags table.
 */
export function applyVirtualTags(tags: VirtualTagConfig[] | undefined, itemIds?: string[]): void {
  if (!tags || tags.length === 0) {
    metadataRepo.clearVirtualTags(itemIds)
    return
  }

  metadataRepo.clearVirtualTags(itemIds)

  try {
    const totalInserted = metadataRepo.evaluateAndInsertVirtualTags(tags, itemIds)

    if (itemIds && itemIds.length > 0) {
      log(`Applied virtual tags: ${totalInserted} entries for ${itemIds.length} items.`)
    } else {
      log(`Applied virtual tags: ${totalInserted} entries (full update).`)
    }
  } catch (e) {
    console.error('[VirtualTags] Failed to apply tags SQL:', e)
  }
}

