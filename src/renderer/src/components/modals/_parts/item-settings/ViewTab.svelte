<script lang="ts">
  import type { MediaFolder, StoredViewSettings, Settings, ViewLayout } from '@shared/types'
  import ViewConfigurator from '@ui/ViewConfigurator.svelte'

  let {
    item,
    groupByKeys,
    selectedLayout = $bindable(),
    selectedClickAction = $bindable(),
    selectedGroupBy = $bindable(),
    gridPosterSize = $bindable(),
    listDescriptionRows = $bindable(),
    showHorizontalScrollbar = $bindable(),
    childViewSettings = $bindable(),
    inheritedSettings,
    inheritedLabel,
    settings
  }: {
    item: MediaFolder
    groupByKeys: string[]
    selectedLayout: ViewLayout
    selectedClickAction: 'detail' | 'navigate'
    selectedGroupBy: string
    gridPosterSize?: number | null
    listDescriptionRows?: number | null
    showHorizontalScrollbar?: boolean | null
    childViewSettings?: StoredViewSettings | null
    inheritedSettings?: StoredViewSettings
    inheritedLabel?: string
    settings: Settings | null
  } = $props()
</script>

<ViewConfigurator
  {item}
  {settings}
  bind:selectedLayout
  bind:selectedClickAction
  bind:selectedGroupBy
  bind:gridPosterSize
  bind:listDescriptionRows
  bind:showHorizontalScrollbar
  bind:childViewSettings
  {inheritedSettings}
  {inheritedLabel}
  {groupByKeys}
/>
