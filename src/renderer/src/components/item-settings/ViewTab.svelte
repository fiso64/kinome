<script lang="ts">
  import ViewConfigurator from '../shared/ViewConfigurator.svelte'

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
    selectedGroupBy = $bindable()
  }: {
    item: MediaFolder & VirtualFolderProps
    groupByKeys: string[]
    selectedLayout: 'grid' | 'list' | 'tree' | 'tabs' | 'sections'
    selectedClickAction: 'detail' | 'navigate'
    selectedGroupBy: string
  } = $props()
</script>

<ViewConfigurator
  bind:selectedLayout
  bind:selectedClickAction
  bind:selectedGroupBy
  {groupByKeys}
/>