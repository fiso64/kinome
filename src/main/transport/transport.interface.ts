import type { AutocompleteSuggestions, LibraryItem, Settings } from '../../shared/types'

/**
 * Defines the contract for a transport layer.
 * A transport layer is responsible for communicating state changes from the core services
 * to the client (e.g., an Electron renderer process or a web browser).
 */
export interface ITransport {
  /**
   * Notifies clients that a batch of library items has been updated.
   * @param items An array of the updated library items.
   */
  notifyLibraryItemsUpdated(items: LibraryItem[]): void



  /**
   * Notifies clients that the autocomplete suggestions have been updated.
   * @param suggestions The new set of autocomplete suggestions.
   */
  notifyAutocompleteSuggestionsUpdated(suggestions: AutocompleteSuggestions): void

  /**
   * Notifies clients that a library item has been deleted from the database.
   * @param itemId The ID of the deleted item.
   */
  notifyLibraryItemDeleted(itemId: string): void

  /**
   * Notifies clients that the application settings have changed.
   * This is used for live updates in the settings modal.
   * @param newSettings The complete new settings object.
   */
  notifySettingsUpdated(newSettings: Settings): void

  /**
   * Triggers a full reload of the client UI.
   * This is used when a critical change occurs, like switching libraries.
   */
  forceRendererReload(): void
}
