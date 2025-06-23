<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'

  let {
    initialSettings,
    onClose,
    onSave,
    groupByKeys
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onSave: (newSettings: Settings['defaultLayoutSettings']) => void
    groupByKeys: string[]
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
      bind:showHorizontalScrollbar={localSettings['horizontal-grid'].showHorizontalScrollbar}
      bind:listDescriptionRows={localSettings.list.listDescriptionRows}
      bind:selectedGroupBy={sharedGroupBy}
      {groupByKeys}
    />
  {/if}
</ModalWindow>
