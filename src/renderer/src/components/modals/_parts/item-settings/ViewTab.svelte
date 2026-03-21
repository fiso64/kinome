<script lang="ts">
  import type { MediaFolder, CascadableViewSettings, Settings, ViewLayout, SortBy } from '@shared/types'
  import ViewConfigurator from '@ui/ViewConfigurator.svelte'

  let {
    item,
    groupByKeys,
    selectedLayout = $bindable(),
    selectedClickAction = $bindable(),
    selectedGroupBy = $bindable(),
    selectedSortBy = $bindable(),
    selectedSortDescending = $bindable(),
    gridPosterSize = $bindable(),
    listDescriptionRows = $bindable(),
    showHorizontalScrollbar = $bindable(),
    scrollHorizontally = $bindable(),
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
    selectedSortBy?: SortBy | null
    selectedSortDescending?: boolean | null
    gridPosterSize?: number | null
    listDescriptionRows?: number | null
    showHorizontalScrollbar?: boolean | null
    scrollHorizontally?: boolean | null
    childViewSettings?: CascadableViewSettings | null
    inheritedSettings?: CascadableViewSettings
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
  bind:selectedSortBy
  bind:selectedSortDescending
  bind:gridPosterSize
  bind:listDescriptionRows
  bind:showHorizontalScrollbar
  bind:scrollHorizontally
  bind:childViewSettings
  {inheritedSettings}
  {inheritedLabel}
  {groupByKeys}
/>
