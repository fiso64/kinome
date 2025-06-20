<script lang="ts">
  import ModalWindow from '../ModalWindow.svelte'
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'

  type LayoutSettings = {
    gridPosterSize?: number
  }

  let {
    initialSettings,
    onClose,
    onSave
  }: {
    initialSettings: LayoutSettings
    onClose: () => void
    onSave: (newSettings: LayoutSettings) => void
  } = $props()

  let localGridPosterSize = $state(initialSettings.gridPosterSize)

  function handleSave() {
    onSave({ gridPosterSize: localGridPosterSize })
    onClose()
  }
</script>

<ModalWindow title="Default Layout Values" {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    configMode={true}
    bind:gridPosterSize={localGridPosterSize}
    settings={initialSettings}
  />
</ModalWindow>