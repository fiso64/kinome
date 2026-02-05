import type { AutocompleteSuggestions, LibraryItem, ScanStatus, Settings } from '../../shared/types'

/**
 * Defines the contract for a transport layer.
 * A transport layer is responsible for communicating state changes from the core services
 * to the client (e.g., a web browser or desktop client).
 */
export interface ITransport {
  /**
   * Notifies clients that a batch of library items has been updated.
   * @param items An array of the updated library items.
   */
  notifyLibraryItemsUpdated(items: LibraryItem[]): void

  /**
   * Notifies clients that the metadata index (suggestions, grouping keys) has been updated.
   * @param index The new metadata index data.
   */
  notifyMetadataIndexUpdated(index: { suggestions: AutocompleteSuggestions; groupByKeys: string[] }): void

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

  /**
   * Notifies clients about the library scan status (discovery + metadata).
   * @param status The current scan status object.
   */
  notifyScanStatusChanged(status: Partial<ScanStatus>): void
}
