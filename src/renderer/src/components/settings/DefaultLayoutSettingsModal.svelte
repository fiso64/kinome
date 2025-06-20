<script lang="ts">
  import ModalWindow from '../ModalWindow.svelte'
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'
  import { LAYOUT_SPECIFIC_SETTINGS_CONFIG } from '../../../../shared/types'

  let {
    initialSettings,
    onClose,
    onSave
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onSave: (newSettings: Settings['defaultLayoutSettings']) => void
  } = $props()

  type ConfigurableLayout = keyof typeof LAYOUT_SPECIFIC_SETTINGS_CONFIG

  const CONFIGURABLE_LAYOUTS = Object.keys(
    LAYOUT_SPECIFIC_SETTINGS_CONFIG
  ) as ConfigurableLayout[]

  let activeTab: ConfigurableLayout = $state('grid')
  let localSettings = $state(JSON.parse(JSON.stringify(initialSettings)))

  function handleSave() {
    if (localSettings) {
      onSave(localSettings)
    }
    onClose()
  }
</script>

<ModalWindow
  title="Default Layout Values"
  {onClose}
  onSave={handleSave}
  maxWidth="700px"
  zIndex={101}
>
  {#snippet header()}
    <div class="tabs">
      {#each CONFIGURABLE_LAYOUTS as layout}
        <button class:active={activeTab === layout} onclick={() => (activeTab = layout)}>
          {layout.charAt(0).toUpperCase() + layout.slice(1)}
        </button>
      {/each}
    </div>
  {/snippet}

  {#if localSettings}
    {#if activeTab === 'grid'}
      <ViewConfigurator
        configMode={true}
        initialConfigLayout="grid"
        bind:gridPosterSize={localSettings.grid.gridPosterSize}
      />
    {:else if activeTab === 'tabs'}
      <ViewConfigurator
        configMode={true}
        initialConfigLayout="tabs"
        bind:selectedGroupBy={localSettings.tabs.groupBy}
      />
    {:else if activeTab === 'sections'}
      <ViewConfigurator
        configMode={true}
        initialConfigLayout="sections"
        bind:selectedGroupBy={localSettings.sections.groupBy}
      />
    {/if}
  {/if}
</ModalWindow>

<style>
  .tabs {
    display: flex;
  }
  .tabs button {
    padding: 0.8rem 1.2rem;
    background: none;
    font-size: 1rem;
    font-weight: 600;
    color: var(--ev-c-text-2);
    border-bottom: 3px solid transparent;
    transition: all 0.2s;
  }
  .tabs button:hover:not(:disabled) {
    color: var(--ev-c-text-1);
    background: none;
  }
  .tabs button.active {
    color: var(--ev-c-text-1);
    border-bottom-color: var(--ev-c-white-soft);
  }
</style>