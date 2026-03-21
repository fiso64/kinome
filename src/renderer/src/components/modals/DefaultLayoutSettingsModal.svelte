<script lang="ts">
  import type { Settings, ViewLayout } from '@shared/types'
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'

  let {
    initialSettings,
    onClose,
    onSave,
    settings
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onSave: (newSettings: Settings['defaultLayoutSettings']) => void
    settings: Settings | null
  } = $props()

  let localSettings = $state(JSON.parse(JSON.stringify(initialSettings)))

  let activeLayout = $state<ViewLayout>('grid')

  let currentGridPosterSize = $state(localSettings?.grid?.gridPosterSize)
  let currentListDescriptionRows = $state(localSettings?.list?.listDescriptionRows)
  let currentShowHorizontalScrollbar = $state(localSettings?.['horizontal-grid']?.showHorizontalScrollbar)
  let currentScrollHorizontally = $state(localSettings?.['button-grid']?.scrollHorizontally)

  $effect(() => {
    if (localSettings && activeLayout) {
      currentGridPosterSize = localSettings[activeLayout]?.gridPosterSize
      currentListDescriptionRows = localSettings[activeLayout]?.listDescriptionRows
      currentShowHorizontalScrollbar = localSettings[activeLayout]?.showHorizontalScrollbar
      currentScrollHorizontally = localSettings[activeLayout]?.scrollHorizontally
    }
  })

  $effect(() => {
    if (localSettings && activeLayout) {
      if (currentGridPosterSize !== undefined) {
        localSettings[activeLayout].gridPosterSize = currentGridPosterSize
      }
      if (currentListDescriptionRows !== undefined) {
        localSettings[activeLayout].listDescriptionRows = currentListDescriptionRows
      }
      if (currentShowHorizontalScrollbar !== undefined) {
        localSettings[activeLayout].showHorizontalScrollbar = currentShowHorizontalScrollbar
      }
      if (currentScrollHorizontally !== undefined) {
        localSettings[activeLayout].scrollHorizontally = currentScrollHorizontally
      }
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
      {settings}
      bind:activeConfigLayout={activeLayout}
      bind:gridPosterSize={currentGridPosterSize}
      bind:showHorizontalScrollbar={currentShowHorizontalScrollbar}
      bind:scrollHorizontally={currentScrollHorizontally}
      bind:listDescriptionRows={currentListDescriptionRows}
    />
  {/if}
</ModalWindow>
