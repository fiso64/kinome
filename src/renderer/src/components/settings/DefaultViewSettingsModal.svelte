<script lang="ts">
  import ModalWindow from '../ModalWindow.svelte'
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'

  type ViewSettings = {
    layout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    clickAction: 'detail' | 'navigate'
    groupBy: string
  }

  let {
    title,
    initialSettings,
    onClose,
    onSave,
    groupByKeys,
    availableLayouts,
    showClickAction
  }: {
    title: string
    initialSettings: ViewSettings
    onClose: () => void
    onSave: (newSettings: ViewSettings) => void
    groupByKeys: string[]
    availableLayouts?: ('grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
  } = $props()

  let selectedLayout = $state(initialSettings.layout)
  let selectedClickAction = $state(initialSettings.clickAction)
  let selectedGroupBy = $state(initialSettings.groupBy)

  function handleSave() {
    onSave({
      layout: selectedLayout,
      clickAction: selectedClickAction,
      groupBy: selectedGroupBy
    })
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

<ModalWindow {title} {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    bind:selectedLayout
    bind:selectedClickAction
    bind:selectedGroupBy
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
  />
</ModalWindow>