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

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'Enter') {
        const target = event.target as HTMLElement
        if (target.tagName !== 'BUTTON') {
          event.preventDefault()
          handleSave()
        }
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<ModalWindow title="Default Layout Values" {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    configMode={true}
    bind:gridPosterSize={localGridPosterSize}
    settings={initialSettings}
  />
</ModalWindow>