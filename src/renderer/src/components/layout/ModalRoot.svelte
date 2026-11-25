<script lang="ts">
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { modalStore } from '@lib/modal-store.svelte'
  import ItemSettingsModal from '../modals/ItemSettingsModal.svelte'
  import ManualSearchModal from '../modals/ManualSearchModal.svelte'
  import PropertiesModal from '../modals/PropertiesModal.svelte'
  import ShortcutsModal from '../modals/ShortcutsModal.svelte'
  import RenameModal from '../modals/RenameModal.svelte'
  import AssignSeasonsModal from '../modals/AssignSeasonsModal.svelte'
  import CreateVirtualFolderModal from '../modals/CreateVirtualFolderModal.svelte'
  import DefaultViewSettingsModal from '../modals/DefaultViewSettingsModal.svelte'
  import SortPinningModal from '../modals/SortPinningModal.svelte'

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
  const isPending = $derived(modalStore.isPending)

  $effect(() => { modalStore.closeUnauthorized() })
</script>

{#if isPending && stack.length === 0}
  <div class="modal-pending-backdrop" role="status" aria-label="Opening dialog"
    transition:fade={{ duration: prefersReducedMotion.current ? 0 : 120 }}>
    <div class="busy-wheel"></div>
  </div>
{/if}

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
  {:else if active.type === 'shortcuts'}
    <ShortcutsModal onClose={() => modalStore.close()} />
  {:else if active.type === 'properties'}
    <PropertiesModal item={active.props.item} onClose={() => modalStore.close()} />
  {:else if active.type === 'rename'}
    <RenameModal
      item={active.props.item}
      onClose={() => modalStore.close()}
      onNeedRefresh={onRefresh}
    />
  {:else if active.type === 'createVirtualFolder'}
    <CreateVirtualFolderModal
      parentItem={active.props.parentItem}
      onClose={() => modalStore.close()}
      onCreated={active.props.onCreated}
    />
  {:else if active.type === 'assignSeasons'}
    <AssignSeasonsModal item={active.props.item} onClose={() => modalStore.close()} />
  {:else if active.type === 'viewSettings'}
    {@const props = active.props as any}
    <DefaultViewSettingsModal
      title={props.title}
      initialSettings={props.initialSettings}
      typeKey={props.typeKey}
      editCapability={props.editCapability}
      onDone={props.onDone}
      onClose={() => modalStore.close()}
      {groupByKeys}
      {settings}
      availableLayouts={props.availableLayouts}
      showClickAction={props.showClickAction}
    />
  {:else if active.type === 'sortPinning'}
    {@const sp = active.props}
    <SortPinningModal item={sp.item} placement={sp.placement} onClose={() => modalStore.close()} onDone={sp.onDone} />
  {/if}
{/each}

<style>
  .modal-pending-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
</style>
