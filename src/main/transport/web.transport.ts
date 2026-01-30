import { Server as SocketServer } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { AutocompleteSuggestions, LibraryItem, Settings } from '../../shared/types'
import type { ITransport } from './transport.interface'

/**
 * A Web-standard implementation of the ITransport interface.
 * Uses Socket.io to communicate state changes to connected web clients.
 */
export class WebTransport implements ITransport {
  private io: SocketServer | null = null

  /**
   * Initializes the WebSocket server using an existing HTTP server.
   * @param server The Node.js HTTP server instance.
   */
  initialize(server: HttpServer) {
    this.io = new SocketServer(server, {
      cors: {
        origin: '*', // For development, allow all. Refine for production.
        methods: ['GET', 'POST']
      }
    })

    this.io.on('connection', (socket) => {
      console.log(`[WebTransport] Client connected: ${socket.id}`)
      socket.on('disconnect', () => {
        console.log(`[WebTransport] Client disconnected: ${socket.id}`)
      })
    })

    console.log('[WebTransport] Socket.io server initialized.')
  }

  notifyLibraryItemsUpdated(items: LibraryItem[]): void {
    console.log(`[WebTransport] Notifying update for ${items.length} items.`)
    this.io?.emit('library-items-updated', items)
  }

  notifyAutocompleteSuggestionsUpdated(suggestions: AutocompleteSuggestions): void {
    console.log('[WebTransport] Notifying suggestions update.')
    this.io?.emit('autocomplete-suggestions-updated', suggestions)
  }

  notifyLibraryItemDeleted(itemId: string): void {
    console.log(`[WebTransport] Notifying deletion of item ${itemId}.`)
    this.io?.emit('library-item-deleted', itemId)
  }

  notifySettingsUpdated(newSettings: Settings): void {
    console.log('[WebTransport] Notifying settings update.')
    this.io?.emit('settings-possibly-updated', newSettings)
  }

  forceRendererReload(): void {
    console.log('[WebTransport] Forcing client reload.')
    this.io?.emit('force-reload-for-new-library')
  }
}
