import { AutocompleteSuggestions, LibraryItem, ScanStatus, Settings } from '@shared/types'
import equal from 'fast-deep-equal'
import type { ITransport } from './transport.interface'
import { visibleItemIds } from '../services/account-filter.service'

/**
 * A Bun/Elysia implementation of the ITransport interface.
 * Uses native Bun WebSockets to communicate state changes.
 */
export class WebTransport implements ITransport {
  // We'll store a reference to the publisher (the Elysia app's server)
  private server: any = null
  // Open sockets per signed-in account, which receive item updates on their account's channel.
  private accounts = new Map<string, number>()

  private currentStatus: ScanStatus = {
    isFileScanningLibrary: false,
    isMetadataFetchingLibrary: false,
    isProbingLocalMedia: false,
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

  broadcast(event: string, payload: any, accountId?: string) {
    if (!this.server) {
      console.warn(`[WebTransport] Attempted to broadcast ${event} before initialization.`)
      return
    }
    this.server.publish(accountId ? `broadcast:${accountId}` : 'broadcast', JSON.stringify({ type: event, data: payload }))
  }

  connect(accountId: string): void {
    this.accounts.set(accountId, (this.accounts.get(accountId) ?? 0) + 1)
  }

  disconnect(accountId: string): void {
    const count = (this.accounts.get(accountId) ?? 0) - 1
    if (count > 0) this.accounts.set(accountId, count)
    else this.accounts.delete(accountId)
  }

  /**
   * Each account receives only the items it may see. An item it cannot see, such as one
   * an edit just hid from it, arrives as removed, by ID alone, so its views drop it.
   */
  notifyLibraryItemsUpdated(items: LibraryItem[], userId?: string): void {
    console.log(`[WebTransport] Notifying update for ${items.length} items.`)
    const ids = items.map((item) => item.id)
    for (const accountId of userId ? [userId] : [...this.accounts.keys()]) {
      const visible = visibleItemIds(accountId, ids)
      const shown = items.filter((item) => visible.has(item.id))
      if (shown.length) this.broadcast('library-items-updated', shown, accountId)
      if (shown.length < items.length) this.broadcast('library-items-removed', ids.filter((id) => !visible.has(id)), accountId)
    }
  }

  notifyMetadataIndexUpdated(index: {
    suggestions: AutocompleteSuggestions
    groupByKeys: string[]
    invalidateItems?: boolean
  }): void {
    console.log('[WebTransport] Notifying metadata index update.')
    this.broadcast('metadata-index-updated', index)
  }

  notifyLibraryItemDeleted(itemId: string): void {
    console.log(`[WebTransport] Notifying deletion of item ${itemId}.`)
    this.broadcast('library-items-removed', [itemId])
  }

  notifySettingsUpdated(newSettings: Settings): void {
    console.log('[WebTransport] Notifying settings update.')
    this.broadcast('settings-possibly-updated', newSettings)
  }

  forceRendererReload(): void {
    console.log('[WebTransport] Forcing client reload.')
    this.broadcast('force-reload-for-new-library', null)
  }

  getCurrentStatus(): ScanStatus {
    return this.currentStatus
  }

  notifyScanStatusChanged(statusUpdate: Partial<ScanStatus>): void {
    const prevStatus = this.currentStatus
    this.currentStatus = { ...this.currentStatus, ...statusUpdate }

    // Aggregate flag calculation
    this.currentStatus.isFastUpdating =
      this.currentStatus.isFileScanningLibrary || this.currentStatus.isMetadataFetchingLibrary

    // Only broadcast if the state has meaningfully changed
    if (!equal(prevStatus, this.currentStatus)) {
      console.log('[WebTransport] Notifying status change:', this.currentStatus)
      this.broadcast('scan-status-changed', this.currentStatus)
    }
  }

  notifyHandlerTestSuccess(sessionId: string): void {
    console.log(`[WebTransport] Notifying handler test success: ${sessionId}`)
    this.broadcast('handler-test-success', { sessionId })
  }
}
