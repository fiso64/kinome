<script lang="ts">
  import ModalWindow from '../ModalWindow.svelte'
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'

  type ViewSettings = {
    layout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    clickAction: 'detail' | 'navigate'
    groupBy: string
    gridPosterSize?: number | null
  }

  let {
    title,
    initialSettings,
    onClose,
    onSave,
    groupByKeys,
    availableLayouts,
    showClickAction,
    settings
  }: {
    title: string
    initialSettings: ViewSettings
    onClose: () => void
    onSave: (newSettings: ViewSettings) => void
    groupByKeys: string[]
    availableLayouts?: ('grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
    settings: Settings | null
  } = $props()

  let selectedLayout = $state(initialSettings.layout)
  let selectedClickAction = $state(initialSettings.clickAction)
  let selectedGroupBy = $state(initialSettings.groupBy)
  let gridPosterSize = $state(initialSettings.gridPosterSize)

  function handleSave() {
    onSave({
      layout: selectedLayout,
      clickAction: selectedClickAction,
      groupBy: selectedGroupBy,
      gridPosterSize: gridPosterSize
    })
    onClose()
  }
</script>

<ModalWindow {title} {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    bind:selectedLayout
    bind:selectedClickAction
    bind:selectedGroupBy
    bind:gridPosterSize
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
    {settings}
  />
</ModalWindow>