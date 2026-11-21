<script lang="ts">
  import type { MediaFolder, EditableViewSettings, Settings } from '@shared/types'
  import ViewConfigurator from '@ui/ViewConfigurator.svelte'

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
    pins: { top: string[]; bottom: string[] }
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
