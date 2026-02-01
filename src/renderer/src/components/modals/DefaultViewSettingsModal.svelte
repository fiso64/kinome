<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'
  import type { StoredViewSettings, Settings } from '../../../../shared/types'
  let {
    typeKey,
    title,
    initialSettings,
    onClose,
    onSave,
    groupByKeys,
    availableLayouts,
    showClickAction,
    settings
  }: {
    typeKey: '_default' | 'movie' | 'tv' | 'season'
    title: string
    initialSettings: StoredViewSettings
    onClose: () => void
    onSave: (newSettings: StoredViewSettings) => void
    groupByKeys: string[]
    availableLayouts?: ('grid' | 'horizontal-grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
    settings: Settings | null
  } = $props()

  let selectedLayout = $state(initialSettings.layout)
  let selectedClickAction = $state(initialSettings.clickAction)
  let selectedGroupBy = $state(initialSettings.groupBy)
  let gridPosterSize = $state(initialSettings.gridPosterSize)
  let listDescriptionRows = $state(initialSettings.listDescriptionRows)
  let showHorizontalScrollbar = $state((initialSettings as any).showHorizontalScrollbar)
  let childViewSettings = $state(initialSettings.childViewSettings || null)

  function handleSave() {
    const newSettings: StoredViewSettings = {
      layout: selectedLayout,
      clickAction: selectedClickAction,
      groupBy: selectedGroupBy,
      gridPosterSize: gridPosterSize,
      listDescriptionRows: listDescriptionRows,
      showHorizontalScrollbar: showHorizontalScrollbar,
      childViewSettings: childViewSettings
    }
    // We don't clean null values here anymore. We allow them to propagate
    // as "reset" signals so that the parent merger can properly remove
    // existing overrides. Final cleanup happens in the parent or at save time.
    onSave(newSettings)
    onClose()
  }
</script>

<ModalWindow {title} {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    {typeKey}
    {settings}
    bind:selectedLayout
    bind:selectedClickAction
    bind:selectedGroupBy
    bind:gridPosterSize
    bind:listDescriptionRows
    bind:showHorizontalScrollbar
    bind:childViewSettings
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
  />
</ModalWindow>
