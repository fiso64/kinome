import * as metadataRepo from '../database/repositories/metadata.repo'
import { markDirty } from './account-filter.service'
import type { VirtualTagConfig } from '@shared/types'

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] [VirtualTags] ${message}`)
}

/**
 * Applies virtual tags in case order and persists the resulting changes.
 */
export function applyVirtualTags(tags: VirtualTagConfig[] | undefined, itemIds?: string[]): void {
  if (itemIds?.length === 0) return

  try {
    const start = performance.now()
    const changed = metadataRepo.replaceVirtualTags(tags, itemIds)
    if (changed > 0) markDirty()

    const scope = itemIds ? `${itemIds.length} items` : 'full library'
    log(`Applied virtual tags for ${scope}: ${changed} writes in ${Math.round(performance.now() - start)} ms.`)
  } catch (e) {
    console.error('[VirtualTags] Failed to apply tags SQL:', e)
  }
}
