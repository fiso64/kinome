<script lang="ts">
  import { modalStore } from '@lib/modal-store.svelte'
  import ItemSettingsModal from '../modals/ItemSettingsModal.svelte'
  import ManualSearchModal from '../modals/ManualSearchModal.svelte'
  import PropertiesModal from '../modals/PropertiesModal.svelte'
  import RenameModal from '../modals/RenameModal.svelte'
  import AssignSeasonsModal from '../modals/AssignSeasonsModal.svelte'
  import DefaultViewSettingsModal from '../modals/DefaultViewSettingsModal.svelte'

  // --- Props (Global state passed in from App.svelte) ---
  let {
    settings = $bindable(),
    groupByKeys,
    onRefresh
  } = $props<{
    settings: any
    groupByKeys: string[]
    onRefresh: () => Promise<void>
  }>()

  const stack = $derived(modalStore.stack)
</script>

{#each stack as active, i (i)}
  {#if active.type === 'itemSettings'}
    <ItemSettingsModal
      item={active.props.item}
      initialTab={(active.props as any).initialTab}
      defaultLayout={(active.props as any).defaultLayout}
      overrideParent={(active.props as any).overrideParent}
      {groupByKeys}
      {settings}
      onClose={() => {
        modalStore.close()
      }}
      onNeedRefresh={onRefresh}
    />
  {:else if active.type === 'manualSearch'}
    <ManualSearchModal
      item={active.props.item}
      initialTab={active.props.initialTab}
      onClose={() => modalStore.close()}
    />
  {:else if active.type === 'properties'}
    <PropertiesModal item={active.props.item} onClose={() => modalStore.close()} />
  {:else if active.type === 'rename'}
    <RenameModal
      item={active.props.item}
      onClose={() => modalStore.close()}
      onNeedRefresh={onRefresh}
    />
  {:else if active.type === 'assignSeasons'}
    <AssignSeasonsModal item={active.props.item} onClose={() => modalStore.close()} />
  {:else if active.type === 'viewSettings'}
    {@const props = active.props as any}
    <DefaultViewSettingsModal
      title={props.title}
      initialSettings={props.initialSettings}
      typeKey={props.typeKey}
      onSave={props.onSave}
      onClose={() => modalStore.close()}
      {groupByKeys}
      {settings}
      availableLayouts={props.availableLayouts}
      showClickAction={props.showClickAction}
    />
  {/if}
{/each}
