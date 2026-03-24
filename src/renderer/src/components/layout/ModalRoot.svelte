<script lang="ts">
  import { fade } from 'svelte/transition'
  import { modalStore } from '@lib/modal-store.svelte'
  import ItemSettingsModal from '../modals/ItemSettingsModal.svelte'
  import ManualSearchModal from '../modals/ManualSearchModal.svelte'
  import PropertiesModal from '../modals/PropertiesModal.svelte'
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
</script>

{#if isPending && stack.length === 0}
  <div class="modal-pending-backdrop" transition:fade={{ duration: 150 }}>
    <div class="modal-pending-spinner"></div>
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
      onSave={props.onSave}
      onClose={() => modalStore.close()}
      {groupByKeys}
      {settings}
      availableLayouts={props.availableLayouts}
      showClickAction={props.showClickAction}
    />
  {:else if active.type === 'sortPinning'}
    {@const sp = active.props}
    <SortPinningModal item={sp.item} initialSortTop={sp.initialSortTop} initialSortBottom={sp.initialSortBottom} onClose={() => modalStore.close()} onSaved={sp.onSaved} />
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

  .modal-pending-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
