<script lang="ts">
  import ViewConfigurator from '../../../ui/ViewConfigurator.svelte'
  import { resolveViewSettings } from '../../../../../../shared/settings-helpers'
  import { ALL_VIEW_OVERRIDE_KEYS } from '../../../../../../shared/types'

  type VirtualFolderProps = {
    isVirtual?: boolean
    physicalParentId?: string
    groupByKey?: string
    groupByValue?: string
  }

  let {
    item,
    groupByKeys,
    selectedLayout = $bindable(),
    selectedClickAction = $bindable(),
    selectedGroupBy = $bindable(),
    gridPosterSize = $bindable(),
    listDescriptionRows = $bindable(),
    settings
  }: {
    item: MediaFolder & VirtualFolderProps
    groupByKeys: string[]
    selectedLayout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    selectedClickAction: 'detail' | 'navigate'
    selectedGroupBy: string
    gridPosterSize?: number | null
    listDescriptionRows?: number | null
    settings: Settings | null
  } = $props()

  const inheritedSettings = $derived.by(() => {
    // To find the true inherited value, we resolve the settings for the item
    // as if its own potential overrides don't exist.
    const itemWithoutOverrides: any = { ...item }
    // Loop through the data-driven list of all possible override keys and remove them.
    for (const key of ALL_VIEW_OVERRIDE_KEYS) {
      delete itemWithoutOverrides[key]
    }
    return resolveViewSettings(itemWithoutOverrides, settings)
  })
</script>

<ViewConfigurator
  bind:selectedLayout
  bind:selectedClickAction
  bind:selectedGroupBy
  bind:gridPosterSize
  bind:listDescriptionRows
  {groupByKeys}
  inheritedGridPosterSize={inheritedSettings.gridPosterSize}
  inheritedGroupBy={inheritedSettings.groupBy}
  inheritedListDescriptionRows={inheritedSettings.listDescriptionRows}
/>