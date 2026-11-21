<script lang="ts">
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import type { MediaFolder } from '@shared/types'
  import { onMount } from 'svelte'
  import { notificationStore } from '@lib/notification-store.svelte'

  let {
    item: initialItem,
    onClose
  }: {
    item: MediaFolder
    onClose: () => void
  } = $props()

  const itemQuery = libraryDataService.getItemDetailsQuery(() => initialItem.id, {
    fields: () => ['id', 'retrieveChildrenMetadata', 'childrenTypeHint', 'processTvChildren']
  })

  // Use the fetched item data if available, otherwise fallback to the initial item prop.
  const item = $derived((itemQuery.data as MediaFolder) || initialItem)

  let seasonStrategy: 'smart' | 'alphabetic' = $state('smart')
  let episodeStrategy: 'smart' | 'alphabetic' = $state('smart')
  let fetchMetadata = $state(true)
  let isSaving = $state(false)

  // TV show processing is enabled by default (undefined or true), and disabled if explicitly false.
  const isTvProcessingEnabled = $derived(item.folderSettings?.processTvChildren !== false)

  $effect(() => {
    if (isTvProcessingEnabled) {
      fetchMetadata = true
    }
  })
  async function handleSave() {
    isSaving = true
    try {
      await window.api.assignSeasonsAndEpisodes(
        item.id,
        seasonStrategy,
        episodeStrategy,
        fetchMetadata
      )
      onClose()
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to assign seasons and episodes.', 'error')
    } finally {
      isSaving = false
    }
  }
</script>

<ModalWindow
  title="Assign Seasons & Episodes"
  {onClose}
  onSave={handleSave}
  saveText={isSaving ? 'Assigning...' : 'Assign'}
  maxWidth="600px"
>
  <div class="form-stack">
    <fieldset class="settings-group">
      <legend>Season numbering</legend>
      <div class="choice-grid">
        <label class="choice-card">
          <input type="radio" name="season-strategy" value="smart" bind:group={seasonStrategy} />
          <div class="option-details">
            <strong>From names</strong>
            <div class="form-hint">
              Parses folder names like "Season 1" or "S01". Falls back to alphabetical sort.
            </div>
          </div>
        </label>
        <label class="choice-card">
          <input
            type="radio"
            name="season-strategy"
            value="alphabetic"
            bind:group={seasonStrategy}
          />
          <div class="option-details">
            <strong>Alphabetical</strong>
            <div class="form-hint">Assigns numbers in folder name order.</div>
          </div>
        </label>
      </div>
    </fieldset>

    <fieldset class="settings-group">
      <legend>Episode numbering</legend>
      <div class="choice-grid">
        <label class="choice-card">
          <input type="radio" name="episode-strategy" value="smart" bind:group={episodeStrategy} />
          <div class="option-details">
            <strong>From names</strong>
            <div class="form-hint">
              Parses filenames like "S01E01". Falls back to alphabetical sort.
            </div>
          </div>
        </label>
        <label class="choice-card">
          <input
            type="radio"
            name="episode-strategy"
            value="alphabetic"
            bind:group={episodeStrategy}
          />
          <div class="option-details">
            <strong>Alphabetical</strong>
            <div class="form-hint">Assigns numbers in file name order.</div>
          </div>
        </label>
      </div>
    </fieldset>

    <div class="settings-group" class:disabled={isTvProcessingEnabled}>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={fetchMetadata} disabled={isTvProcessingEnabled} />
        <span>Fetch season details after assignment</span>
      </label>
      {#if isTvProcessingEnabled}
        <p class="form-hint">
          This is always enabled because "Enable TV show processing" is active for this item.
        </p>
      {/if}
    </div>
  </div>
</ModalWindow>

<style>
  .settings-group { min-width: 0; border: 0; padding: 0; }
  legend { font-size: .9rem; font-weight: 650; margin-bottom: .45rem; }
  .settings-group.disabled { opacity: .7; }
  .checkbox-label { display: flex; align-items: center; gap: .55rem; font-size: .9rem; }
  .settings-group > .form-hint { margin: .25rem 0 0 1.5rem; }
</style>
