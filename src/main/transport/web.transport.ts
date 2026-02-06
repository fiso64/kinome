import { AutocompleteSuggestions, LibraryItem, ScanStatus, Settings } from '@shared/types'
import type { ITransport } from './transport.interface'

/**
 * A Bun/Elysia implementation of the ITransport interface.
 * Uses native Bun WebSockets to communicate state changes.
 */
export class WebTransport implements ITransport {
  // We'll store a reference to the publisher (the Elysia app's server)
  private server: any = null

  private currentStatus: ScanStatus = {
    isFileScanningLibrary: false,
    isMetadataFetchingLibrary: false,
    isFastUpdating: false
  }

  /**
   * Initializes the transport with the Bun server instance.
   * @param server The Bun server instance.
   */
  initialize(server: any) {
    this.server = server
    console.log('[WebTransport] Native WebSocket transport initialized.')
  }

  private broadcast(event: string, data: any) {
    if (!this.server) {
      console.warn(`[WebTransport] Attempted to broadcast ${event} before initialization.`)
      return
    }
    // In Bun/Elysia, we can publish to a topic.
    // We'll assume all clients are subscribed to "broadcast".
    this.server.publish('broadcast', JSON.stringify({ type: event, data }))
  }

  notifyLibraryItemsUpdated(items: LibraryItem[]): void {
    console.log(`[WebTransport] Notifying update for ${items.length} items.`)
    this.broadcast('library-items-updated', items)
  }

  notifyMetadataIndexUpdated(index: {
    suggestions: AutocompleteSuggestions
    groupByKeys: string[]
  }): void {
    console.log('[WebTransport] Notifying metadata index update.')
    this.broadcast('metadata-index-updated', index)
  }

  notifyLibraryItemDeleted(itemId: string): void {
    console.log(`[WebTransport] Notifying deletion of item ${itemId}.`)
    this.broadcast('library-item-deleted', itemId)
  }

  notifySettingsUpdated(newSettings: Settings): void {
    console.log('[WebTransport] Notifying settings update.')
    this.broadcast('settings-possibly-updated', newSettings)
  }

  forceRendererReload(): void {
    console.log('[WebTransport] Forcing client reload.')
    this.broadcast('force-reload-for-new-library', null)
  }

  notifyScanStatusChanged(statusUpdate: Partial<ScanStatus>): void {
    const prevStatus = { ...this.currentStatus }
    this.currentStatus = { ...this.currentStatus, ...statusUpdate }

    // Aggregate flag calculation
    this.currentStatus.isFastUpdating =
      this.currentStatus.isFileScanningLibrary || this.currentStatus.isMetadataFetchingLibrary

    // Only broadcast if the state has meaningfully changed
    if (JSON.stringify(prevStatus) !== JSON.stringify(this.currentStatus)) {
      console.log('[WebTransport] Notifying status change:', this.currentStatus)
      this.broadcast('scan-status-changed', this.currentStatus)
    }
  }
}
