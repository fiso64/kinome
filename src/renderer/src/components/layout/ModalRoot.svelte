<script lang="ts">
  import { modalStore } from '../../lib/modal-store.svelte'
  import { navStoreV2 } from '../../lib/navigation-store-v2.svelte'
  import SettingsModal from '../modals/SettingsModal.svelte'
  import ItemSettingsModal from '../modals/ItemSettingsModal.svelte'
  import ManualSearchModal from '../modals/ManualSearchModal.svelte'
  import PropertiesModal from '../modals/PropertiesModal.svelte'
  import RenameModal from '../modals/RenameModal.svelte'
  import AssignSeasonsModal from '../modals/AssignSeasonsModal.svelte'
  import InitialFolderSettingsModal from '../modals/InitialFolderSettingsModal.svelte'
  import { api } from '../../lib/api'

  import { createQuery } from '@tanstack/svelte-query'

  // --- Props (Global state passed in from App.svelte) ---
  let {
    settings = $bindable(),
    groupByKeys,
    onRefresh,
    onApplyInitialSettings
  } = $props<{
    settings: any
    groupByKeys: string[]
    onRefresh: () => Promise<void>
    onApplyInitialSettings: (settings: any[]) => Promise<void>
  }>()

  const active = $derived(modalStore.activeModal)
  const navSettingsOpen = $derived(navStoreV2.state.settingsModalOpen)
  const navItemSettingsId = $derived(navStoreV2.state.itemSettingsId)

  const navItemSettingsQuery = createQuery(() => ({
    queryKey: ['item', navStoreV2.state.itemSettingsId],
    queryFn: () => api.getItemV2(navStoreV2.state.itemSettingsId!),
    enabled: !!navStoreV2.state.itemSettingsId
  }))

  const itemSettingsItem = $derived(
    active?.type === 'itemSettings' ? active.props.item : navItemSettingsQuery.data
  )
</script>

{#if active || navSettingsOpen || (navItemSettingsId && itemSettingsItem)}
  {#if active?.type === 'settings' || navSettingsOpen}
    <SettingsModal
      {settings}
      on:close={() => {
        modalStore.close()
        navStoreV2.closeModals()
        api.getSettings().then((s) => (settings = s))
      }}
      on:fullRescanCompleted={(e) => {
        modalStore.open('initialFolderSettings', { root: e.detail.root })
      }}
    />
  {:else if active?.type === 'itemSettings' || (navItemSettingsId && itemSettingsItem)}
    <ItemSettingsModal
      item={itemSettingsItem}
      initialTab={(active?.props as any)?.initialTab}
      defaultLayout={(active?.props as any)?.defaultLayout}
      {groupByKeys}
      {settings}
      onClose={() => {
        modalStore.close()
        navStoreV2.closeModals()
      }}
      onNeedRefresh={onRefresh}
    />
  {:else if active?.type === 'manualSearch'}
    <ManualSearchModal
      item={active.props.item}
      initialTab={active.props.initialTab}
      onClose={() => modalStore.close()}
    />
  {:else if active?.type === 'properties'}
    <PropertiesModal item={active.props.item} onClose={() => modalStore.close()} />
  {:else if active?.type === 'rename'}
    <RenameModal
      item={active.props.item}
      onClose={() => modalStore.close()}
      onNeedRefresh={onRefresh}
    />
  {:else if active?.type === 'initialFolderSettings'}
    <InitialFolderSettingsModal
      root={active.props.root}
      onApply={onApplyInitialSettings}
      onClose={() => {
        onApplyInitialSettings([])
        modalStore.close()
      }}
    />
  {:else if active?.type === 'assignSeasons'}
    <AssignSeasonsModal item={active.props.item} onClose={() => modalStore.close()} />
  {/if}
{/if}
