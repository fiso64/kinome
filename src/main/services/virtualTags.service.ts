import * as metadataRepo from '../database/repositories/metadata.repo'
import { runTransaction } from '../database/client'
import { markDirty } from './account-filter.service'
import type { VirtualTagConfig } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [VirtualTags] ${message}`)
}

/**
 * Applies virtual tags by evaluating SQL CASE expressions against media items
 * and writing results to the item_virtual_tags table.
 */
export function applyVirtualTags(tags: VirtualTagConfig[] | undefined, itemIds?: string[]): void {
  if (itemIds?.length === 0) return

  try {
    const totalInserted = runTransaction(() => {
      metadataRepo.clearVirtualTags(itemIds)
      return tags?.length ? metadataRepo.evaluateAndInsertVirtualTags(tags, itemIds) : 0
    })
    markDirty()

    if (itemIds && itemIds.length > 0) {
      log(`Applied virtual tags: ${totalInserted} entries for ${itemIds.length} items.`)
    } else {
      log(`Applied virtual tags: ${totalInserted} entries (full update).`)
    }
  } catch (e) {
    console.error('[VirtualTags] Failed to apply tags SQL:', e)
  }
}
