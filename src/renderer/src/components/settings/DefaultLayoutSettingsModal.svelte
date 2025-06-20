<script lang="ts">
  import ModalWindow from '../ModalWindow.svelte'
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'

  let {
    initialSettings,
    onClose,
    onSave
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onSave: (newSettings: Settings['defaultLayoutSettings']) => void
  } = $props()

  let localSettings = $state(JSON.parse(JSON.stringify(initialSettings)))

  // Since tabs and sections share the 'groupBy' setting at the global default level,
  // we can bind them to a single state variable.
  let sharedGroupBy = $state(localSettings?.tabs?.groupBy ?? 'folder')

  // Keep the underlying settings object in sync with the shared state.
  $effect(() => {
    if (localSettings) {
      localSettings.tabs.groupBy = sharedGroupBy
      localSettings.sections.groupBy = sharedGroupBy
    }
  })

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
  {#if localSettings}
    <ViewConfigurator
      configMode={true}
      bind:gridPosterSize={localSettings.grid.gridPosterSize}
      bind:selectedGroupBy={sharedGroupBy}
      groupByKeys={['folder']}
    />
  {/if}
</ModalWindow>