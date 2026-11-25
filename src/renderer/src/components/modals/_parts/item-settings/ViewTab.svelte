<script lang="ts">
  import type { MediaFolder, EditableViewSettings, Settings } from '@shared/types'
  import ViewConfigurator from '@ui/ViewConfigurator.svelte'
  import type { SortPlacement } from '@shared/sort-placement'

  let {
    item,
    groupByKeys,
    viewSettings = $bindable<EditableViewSettings>({}),
    selectedGroupBy = $bindable(),
    inheritedSettings,
    inheritedLabel,
    settings,
    pins = $bindable()
  }: {
    item: MediaFolder
    groupByKeys: string[]
    viewSettings?: EditableViewSettings
    selectedGroupBy?: string | null
    inheritedSettings?: import('@shared/types').CascadableViewSettings
    inheritedLabel?: string
    settings: Settings | null
    pins: Required<SortPlacement>
  } = $props()
</script>

<ViewConfigurator
  {item}
  {settings}
  bind:pins
  bind:viewSettings
  bind:selectedGroupBy
  {inheritedSettings}
  {inheritedLabel}
  {groupByKeys}
/>
