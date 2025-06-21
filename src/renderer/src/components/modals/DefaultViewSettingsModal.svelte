<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'
  import type { StoredViewSettings } from '../../../../shared/types'
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
    availableLayouts?: ('grid' | 'list' | 'tree' | 'tabs' | 'sections')[]
    showClickAction?: boolean
    settings: Settings | null
  } = $props()

  let selectedLayout = $state(initialSettings.layout)
  let selectedClickAction = $state(initialSettings.clickAction)
  let selectedGroupBy = $state(initialSettings.groupBy)
  let gridPosterSize = $state(initialSettings.gridPosterSize)
  let listDescriptionRows = $state(initialSettings.listDescriptionRows)

  function handleSave() {
    const newSettings: StoredViewSettings = {
      layout: selectedLayout,
      clickAction: selectedClickAction,
      groupBy: selectedGroupBy,
      gridPosterSize: gridPosterSize,
      listDescriptionRows: listDescriptionRows
    }
    // Remove undefined/null keys to keep stored settings clean
    Object.keys(newSettings).forEach(
      (key) =>
        (newSettings[key as keyof StoredViewSettings] === undefined ||
          newSettings[key as keyof StoredViewSettings] === null) &&
        delete newSettings[key as keyof StoredViewSettings]
    )

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
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
  />
</ModalWindow>
