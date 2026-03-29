<script lang="ts">
  import type { Settings, ViewLayout, EditableViewSettings } from '@shared/types'
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

  let viewSettings = $state<EditableViewSettings>({
    gridPosterSize: localSettings?.grid?.gridPosterSize,
    listDescriptionRows: localSettings?.list?.listDescriptionRows,
    showHorizontalScrollbar: localSettings?.['horizontal-grid']?.showHorizontalScrollbar,
    scrollHorizontally: localSettings?.['button-grid']?.scrollHorizontally,
  })

  $effect(() => {
    if (localSettings && activeLayout) {
      viewSettings = {
        gridPosterSize: localSettings[activeLayout]?.gridPosterSize,
        listDescriptionRows: localSettings[activeLayout]?.listDescriptionRows,
        showHorizontalScrollbar: localSettings[activeLayout]?.showHorizontalScrollbar,
        scrollHorizontally: localSettings[activeLayout]?.scrollHorizontally,
      }
    }
  })

  $effect(() => {
    if (localSettings && activeLayout) {
      if (viewSettings.gridPosterSize !== undefined) {
        localSettings[activeLayout].gridPosterSize = viewSettings.gridPosterSize
      }
      if (viewSettings.listDescriptionRows !== undefined) {
        localSettings[activeLayout].listDescriptionRows = viewSettings.listDescriptionRows
      }
      if (viewSettings.showHorizontalScrollbar !== undefined) {
        localSettings[activeLayout].showHorizontalScrollbar = viewSettings.showHorizontalScrollbar
      }
      if (viewSettings.scrollHorizontally !== undefined) {
        localSettings[activeLayout].scrollHorizontally = viewSettings.scrollHorizontally
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
      bind:viewSettings
    />
  {/if}
</ModalWindow>
