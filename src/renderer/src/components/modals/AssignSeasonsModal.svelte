<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import type { MediaFolder } from '@shared/types'

  let {
    item,
    onClose
  }: {
    item: MediaFolder
    onClose: () => void
  } = $props()

  let seasonStrategy: 'smart' | 'alphabetic' = $state('smart')
  let episodeStrategy: 'smart' | 'alphabetic' = $state('smart')
  let fetchMetadata = $state(true)
  let isSaving = $state(false)

  // TV show processing is enabled by default (undefined or true), and disabled if explicitly false.
  const isTvProcessingEnabled = $derived(item.scraperSettings?.process_tv_children !== false)

  async function handleSave() {
    isSaving = true
    await window.api.assignSeasonsAndEpisodes(
      item.id,
      seasonStrategy,
      episodeStrategy,
      fetchMetadata
    )
    isSaving = false
    onClose()
  }
</script>

<ModalWindow
  title="Assign Seasons & Episodes"
  {onClose}
  onSave={handleSave}
  saveText={isSaving ? 'Assigning...' : 'Assign'}
  maxWidth="600px"
>
  <div class="content">
    <div class="settings-group">
      <h4>Assign Seasons</h4>
      <div class="layout-options vertical">
        <label class="layout-option vertical-item">
          <input type="radio" name="season-strategy" value="smart" bind:group={seasonStrategy} />
          <div class="option-details">
            <div class="option-label">Smart</div>
            <div class="option-description">
              Parses folder names like "Season 1" or "S01". Falls back to alphabetical sort.
            </div>
          </div>
        </label>
        <label class="layout-option vertical-item">
          <input
            type="radio"
            name="season-strategy"
            value="alphabetic"
            bind:group={seasonStrategy}
          />
          <div class="option-details">
            <div class="option-label">Alphabetic</div>
            <div class="option-description">Sorts all season folders alphabetically.</div>
          </div>
        </label>
      </div>
    </div>

    <div class="settings-group">
      <h4>Assign Episodes</h4>
      <div class="layout-options vertical">
        <label class="layout-option vertical-item">
          <input type="radio" name="episode-strategy" value="smart" bind:group={episodeStrategy} />
          <div class="option-details">
            <div class="option-label">Smart</div>
            <div class="option-description">
              Parses filenames like "S01E01". Falls back to alphabetical sort.
            </div>
          </div>
        </label>
        <label class="layout-option vertical-item">
          <input
            type="radio"
            name="episode-strategy"
            value="alphabetic"
            bind:group={episodeStrategy}
          />
          <div class="option-details">
            <div class="option-label">Alphabetic</div>
            <div class="option-description">Sorts all episode files alphabetically.</div>
          </div>
        </label>
      </div>
    </div>

    <div class="settings-group" class:disabled={isTvProcessingEnabled}>
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={fetchMetadata} disabled={isTvProcessingEnabled} />
        <span>Fetch season details after assignment</span>
      </label>
      {#if isTvProcessingEnabled}
        <p class="help-text">
          This is always enabled because "Enable TV show processing" is active for this item.
        </p>
      {/if}
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  h4 {
    font-weight: bold;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .settings-group.disabled {
    opacity: 0.6;
  }
  .layout-options {
    display: flex;
    gap: 1rem;
    flex-direction: column;
  }
  .layout-option {
    cursor: pointer;
    transition:
      border-color 0.2s,
      background-color 0.2s;
  }

  .vertical-item {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
  }
  .vertical-item:hover {
    background-color: var(--color-background);
  }
  .vertical-item input[type='radio'] {
    margin-top: 0.2rem;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }
  .option-label {
    font-weight: bold;
  }
  .option-description {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
  }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1rem;
    cursor: pointer;
    font-weight: bold;
  }
  .checkbox-label input {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    margin-left: 1.85rem;
    margin-top: -0.5rem;
  }
</style>
