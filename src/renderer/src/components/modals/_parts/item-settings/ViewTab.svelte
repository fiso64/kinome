<script lang="ts">
  import ViewConfigurator from '../../../ui/ViewConfigurator.svelte'

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
</script>

<ViewConfigurator
  {item}
  {settings}
  bind:selectedLayout
  bind:selectedClickAction
  bind:selectedGroupBy
  bind:gridPosterSize
  bind:listDescriptionRows
  {groupByKeys}
/>