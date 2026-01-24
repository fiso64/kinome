<script lang="ts">
  import { modalStore } from '../../lib/modal-store.svelte'
  import SettingsModal from '../modals/SettingsModal.svelte'
  import ItemSettingsModal from '../modals/ItemSettingsModal.svelte'
  import ManualSearchModal from '../modals/ManualSearchModal.svelte'
  import PropertiesModal from '../modals/PropertiesModal.svelte'
  import RenameModal from '../modals/RenameModal.svelte'
  import AssignSeasonsModal from '../modals/AssignSeasonsModal.svelte'
  import InitialFolderSettingsModal from '../modals/InitialFolderSettingsModal.svelte'
  import { api } from '../../lib/api'

  // --- Props (Global state passed in from App.svelte) ---
  let { settings = $bindable(), groupByKeys, onRefresh, onApplyInitialSettings } = $props<{
    settings: any
    groupByKeys: string[]
    onRefresh: () => Promise<void>
    onApplyInitialSettings: (settings: any[]) => Promise<void>
  }>()

  const active = $derived(modalStore.activeModal)
</script>

{#if active}
  {#if active.type === 'settings'}
    <SettingsModal
      {settings}
      on:close={() => {
        modalStore.close()
        api.getSettings().then((s) => (settings = s))
      }}
      on:fullRescanCompleted={(e) => {
        modalStore.open('initialFolderSettings', { root: e.detail.root })
      }}
    />
  {:else if active.type === 'itemSettings'}
    <ItemSettingsModal
      item={active.props.item}
      initialTab={active.props.initialTab}
      defaultLayout={active.props.defaultLayout}
      {groupByKeys}
      {settings}
      onClose={() => modalStore.close()}
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
  {:else if active.type === 'initialFolderSettings'}
    <InitialFolderSettingsModal
      root={active.props.root}
      onApply={onApplyInitialSettings}
      onClose={() => {
        onApplyInitialSettings([])
        modalStore.close()
      }}
    />
  {:else if active.type === 'assignSeasons'}
    <AssignSeasonsModal item={active.props.item} onClose={() => modalStore.close()} />
  {/if}
{/if}
