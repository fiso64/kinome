<script lang="ts">
  import equal from 'fast-deep-equal'
  import { DEFAULT_VIDEO_QUALITIES, normalizePlaybackEncoding } from '@shared/playback-quality'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { api } from '@lib/api'
  import Icon, { type IconName } from '@components/ui/Icon.svelte'
  import Skeleton from '@components/ui/Skeleton.svelte'
  import { formatLayoutString } from '@shared/settings-helpers'
  import { dialogStore } from '@lib/dialog-store'
  import DefaultViewSettingsModal from '@modals/DefaultViewSettingsModal.svelte'
  import DefaultLayoutSettingsModal from '@modals/DefaultLayoutSettingsModal.svelte'
  import PlayerCommandsModal from '@modals/PlayerCommandsModal.svelte'
  import CustomActionsModal from '@modals/CustomActionsModal.svelte'
  import VirtualTagModal from '@modals/VirtualTagModal.svelte'
  import AccountModal from '@modals/AccountModal.svelte'
  import LibrarySettingsForm from '@components/settings/LibrarySettingsForm.svelte'
  import PlaybackSettingsForm from '@components/settings/PlaybackSettingsForm.svelte'
  import LibraryTreeBrowser, { type FolderDrafts } from '@components/settings/LibraryTreeBrowser.svelte'
  import type { DefaultLayoutKey } from '@shared/types'
  import { DEFAULT_LAYOUTS_CONFIG } from '@shared/types'
  import type {
    Settings,
    AutocompleteSuggestions,
    MediaSource,
    VirtualTagConfig,
    Account,
    AccountRole,
    Capability
  } from '@shared/types'
  import { navStore } from '@lib/navigation-store.svelte'
  import { authStore } from '@lib/auth-store.svelte'

  let { settings }: { settings: Settings | null } = $props()

  const TABS = {
    general: { label: 'General', icon: 'settings', capability: 'editSettings' },
    accounts: { label: 'Accounts', icon: 'user', capability: null },
    library: { label: 'Library', icon: 'folder', capability: 'editSettings' },
    playback: { label: 'Playback', icon: 'play', capability: null },
    view: { label: 'View', icon: 'grid', capability: 'editSettings' },
    virtualTags: { label: 'Virtual Tags', icon: 'filter', capability: 'editSettings' }
  } satisfies Record<string, { label: string; icon: IconName; capability: Capability | null }>

  type SettingsTab = keyof typeof TABS
  const tabIds = Object.keys(TABS) as SettingsTab[]
  const layoutKeys = Object.keys(DEFAULT_LAYOUTS_CONFIG) as DefaultLayoutKey[]

  function tabControl(tab: SettingsTab) {
    const capability = TABS[tab].capability
    return capability ? authStore.control(capability) : { disabled: false }
  }

  const availableTabs = $derived(tabIds.filter((tab) => !tabControl(tab).disabled))
  let selectedTab = $state<SettingsTab>('general')
  const activeTab = $derived(availableTabs.includes(selectedTab) ? selectedTab : 'playback')
  let editor = $state<
    | { type: 'view'; key: DefaultLayoutKey }
    | { type: 'layout' | 'players' | 'actions' }
    | { type: 'tag'; tag: VirtualTagConfig }
    | null
  >(null)

  function closeEditor() {
    editor = null
  }

  function editableSettings(settings: Settings) {
    return {
      playerCommands: settings.playerCommands ?? [],
      playbackConversion: settings.playbackConversion ?? 'full',
      defaultPlaybackQuality: settings.defaultPlaybackQuality ?? 'original',
      playbackQualities: settings.playbackQualities ?? [...DEFAULT_VIDEO_QUALITIES],
      playbackEncoding: normalizePlaybackEncoding(settings.playbackEncoding),
      customActions: settings.customActions ?? [],
      tmdbApiKey: settings.tmdbApiKey,
      useLogos: settings.useLogos,
      creditsDisplay: settings.creditsDisplay,
      grayOutWatched: settings.grayOutWatched,
      showContinueWatching: settings.showContinueWatching,
      showNextUp: settings.showNextUp,
      itemDetailBackdropSize: settings.itemDetailBackdropSize,
      itemDetailBackdropBlur: settings.itemDetailBackdropBlur,
      virtualTags: (settings.virtualTags ?? []).map((tag) => ({
        ...tag, id: tag.id || crypto.randomUUID(), cases: tag.cases ?? []
      })),
      libraryLocation: settings.libraryLocation,
      mediaSources: settings.mediaSources?.length
        ? settings.mediaSources
        : [{ id: crypto.randomUUID(), path: '', isRelative: false }],
      shadowSources: settings.shadowSources ?? false,
      refetchRemoteMetadataOnFileChange: settings.refetchRemoteMetadataOnFileChange ?? true,
      shadowMinDepth: settings.shadowMinDepth ?? 1,
      serverPort: settings.serverPort ?? 3000,
      serverHost: settings.serverHost ?? '::',
      defaultLayoutSettings: settings.defaultLayoutSettings,
      defaultLayouts: settings.defaultLayouts
    } satisfies Partial<Settings>
  }

  let draft = $state<ReturnType<typeof editableSettings> | null>(null)
  let saved = $state.raw<ReturnType<typeof editableSettings> | null>(null)
  const previewSettings = $derived(settings && draft ? { ...settings, ...draft } : settings)
  let enabledPlayerIds = $state<string[]>([])
  let playbackConversionAvailable = $state(false)
  let folderDrafts = $state<FolderDrafts>({})
  const changedFolders = $derived(Object.entries(folderDrafts).filter(([, folder]) =>
    !equal(folder.saved, folder.current)
  ))
  let saving = $state(false)
  let switchingLibrary = $state(false)
  let didSave = $state(false)
  const hasServerChanges = $derived(!equal(draft, saved))
  const savePermission = $derived(
    hasServerChanges && !authStore.can.editSettings ? 'editSettings'
      : changedFolders.length > 0 && !authStore.can.editMetadata ? 'editMetadata'
      : null
  )
  const hasChanges = $derived(
    hasServerChanges ||
    !equal(enabledPlayerIds, clientSettingsStore.settings.enabledPlayerIds) ||
    changedFolders.length > 0
  )

  // Accounts tab
  let allAccounts = $state<Account[]>([])
  let editingAccount = $state<Account | null>(null)
  let editingAccountIsSelf = $state(false)
  let showCreateAccount = $state(false)
  let newAccountUsername = $state('')
  let newAccountPassword = $state('')
  let newAccountRole = $state<AccountRole>('normal')
  let createAccountMessage = $state({ text: '', type: '' })
  let creatingAccount = $state(false)

  let isSettingsLoading = $state(true)

  let suggestions = $state<AutocompleteSuggestions>({
    mediaType: [],
    genre: [],
    tags: {},
    virtualTags: {},
    person: null
  })

  const groupByKeys = $derived([
    'folder',
    'mediaType',
    'genre',
    'year',
    ...Object.keys(suggestions.virtualTags ?? {}).map((vt) => `vt.${vt}`),
    ...Object.keys(suggestions.tags ?? {}).map((k) => `tags.${k}`)
  ])

  $effect(() => {
    return navStore.guardSettingsExit(confirmLeave)
  })

  $effect(() => {
    if (switchingLibrary || (!hasChanges && !editor && !saving)) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  })

  $effect(() => {
    api.getSettings().then((s) => {
      saved = editableSettings(s)
      draft = structuredClone(saved)
      playbackConversionAvailable = s.playbackConversionAvailable ?? false
      enabledPlayerIds = [...clientSettingsStore.settings.enabledPlayerIds]
    }).catch((err: any) => {
      dialogStore.showError({ title: 'Failed to Load Settings', message: err.message || 'Could not load settings.' })
    }).finally(() => {
      isSettingsLoading = false
    })

    api.getAutocompleteSuggestions().then((data) => (suggestions = data))

    const handleKeydown = (event: KeyboardEvent): void => {
      if (editor || editingAccount || saving) return

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const currentIndex = availableTabs.indexOf(activeTab)
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + availableTabs.length) % availableTabs.length
          : (currentIndex + 1) % availableTabs.length
        selectedTab = availableTabs[nextIndex]
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })

  $effect(() => {
    if (authStore.can.manageAccounts) void loadAccounts()
    else {
      allAccounts = []
      if (!editingAccountIsSelf) editingAccount = null
      showCreateAccount = false
    }
    if (!authStore.can.editSettings && editor?.type !== 'players') editor = null
  })

  function confirmLeave(): boolean | Promise<boolean> {
    if (saving) return false
    if (!hasChanges && !editor) return true
    return promptToLeave()
  }

  async function promptToLeave(): Promise<boolean> {
    const choice = await dialogStore.showDialog({
      title: 'Unsaved Settings',
      message: editor
        ? 'Leaving Settings will discard pending changes and close the open editor.'
        : savePermission
          ? 'You no longer have permission to save these changes.'
          : 'Save your changes before leaving Settings?',
      buttons: [
        { label: 'Keep Editing', value: 'stay', class: 'secondary' },
        { label: 'Discard Changes', value: 'discard', class: 'danger' },
        ...(!editor && !savePermission ? [{ label: 'Save Changes', value: 'save', class: 'primary' as const }] : [])
      ]
    })
    if (choice === 'save') return handleSave()
    return choice === 'discard'
  }

  function changedValues<T extends object>(current: T, previous: T): Partial<T> {
    return Object.fromEntries(Object.entries(current).filter(([key, value]) =>
      !equal(value, previous[key as keyof T])
    )) as Partial<T>
  }

  async function handleSave(): Promise<boolean> {
    if (!draft || !saved || saving) return false
    const pending = $state.snapshot(draft)
    const { libraryLocation, ...patch } = changedValues(pending, saved)
    if (savePermission) {
      dialogStore.showError({ title: 'Permission Required', message: 'Your account cannot save these server changes.' })
      return false
    }
    if (pending.serverPort !== saved.serverPort &&
      (!Number.isInteger(pending.serverPort) || pending.serverPort < 1 || pending.serverPort > 65535)) {
      dialogStore.showError({ title: 'Invalid Server Port', message: 'Enter a port from 1 to 65535.' })
      return false
    }
    if (patch.defaultPlaybackQuality !== undefined || patch.playbackQualities !== undefined) {
      const qualities = ['original', 'remux', ...pending.playbackQualities]
      if (!qualities.includes(pending.defaultPlaybackQuality)) {
        patch.defaultPlaybackQuality = 'original'
        pending.defaultPlaybackQuality = 'original'
      }
    }

    const wasLibLocationChanged = libraryLocation !== undefined
    const prevSources = saved.mediaSources
    const mediaSources = pending.mediaSources
    const prevSourcesById = new Map(prevSources.map((source) => [source.id, source]))
    const mediaPathChanged = mediaSources.length !== prevSources.length || mediaSources.some((source) => {
      const previous = prevSourcesById.get(source.id)
      return source.path !== previous?.path || source.isRelative !== previous?.isRelative
    })

    saving = true
    didSave = false
    let committedChanges = false
    try {
      // Folder IDs belong to the current library, so finish these edits before switching libraries.
      for (const [id, folder] of changedFolders) {
        const folderSettings = changedValues(folder.current, folder.saved)
        await api.userUpdateItem({ id, folderSettings })
        folder.saved = { ...folder.current }
        committedChanges = true
      }
      if (Object.keys(patch).length > 0) {
        await api.saveSettings(patch)
        committedChanges = true
        saved = { ...pending, libraryLocation: saved.libraryLocation }
        draft.defaultPlaybackQuality = pending.defaultPlaybackQuality
      }
      // A new custom player must exist on the server before its ID is saved on this browser.
      if (!equal(enabledPlayerIds, clientSettingsStore.settings.enabledPlayerIds)) {
        clientSettingsStore.update({ enabledPlayerIds: [...enabledPlayerIds] })
        committedChanges = true
      }
      if (wasLibLocationChanged) {
        switchingLibrary = true
        await api.saveSettings({ libraryLocation })
        saved = { ...pending }
        return true
      }
      if (mediaPathChanged && authStore.can.triggerLibraryScan) await chooseScan(mediaSources)
      didSave = true
      return true
    } catch (err: any) {
      dialogStore.showError({
        title: 'Error Saving Settings',
        message: err.message || 'Failed to save settings.',
        detail: committedChanges ? 'Some changes were saved. You can retry the remaining changes.' : undefined
      })
      return false
    } finally {
      switchingLibrary = false
      saving = false
    }
  }

  async function chooseScan(mediaSources: MediaSource[]) {
    const choice = await dialogStore.showDialog({
      title: 'Scan Updated Media Sources?',
      message: 'Your media source changes were saved. Choose whether to scan them now.',
      detail:
        'A "Full Rescan" is for new libraries and wipes all metadata. A "Refresh" syncs changes for the existing library.',
      buttons: [
        { label: 'Skip Scan', value: 'nothing', class: 'secondary' },
        { label: 'Full Rescan (Wipe)', value: 'full_rescan', class: 'danger' },
        { label: 'Refresh (Sync)', value: 'rescan', class: 'primary' }
      ]
    })
    try {
      if (choice === 'full_rescan') {
        for (const source of mediaSources) {
          await api.saveSource(source)
        }
        await api.performScan()
      } else if (choice === 'rescan') {
        await api.performScan()
      }
    } catch (err: any) {
      dialogStore.showError({ title: 'Error', message: err.message || 'Failed to perform scan.' })
      return
    }
  }

  async function loadAccounts() {
    if (!authStore.can.manageAccounts) return
    try {
      const accounts = await api.getAccounts()
      if (authStore.can.manageAccounts) allAccounts = accounts
    } catch { /* silently ignore */ }
  }

  function openAccountModal(account: Account, isSelf: boolean) {
    editingAccount = account
    editingAccountIsSelf = isSelf
  }

  async function handleCreateAccount() {
    if (!authStore.can.manageAccounts) return
    createAccountMessage = { text: '', type: '' }
    if (!newAccountUsername.trim()) {
      createAccountMessage = { text: 'Username is required.', type: 'error' }
      return
    }
    if (!newAccountPassword) {
      createAccountMessage = { text: 'Password is required.', type: 'error' }
      return
    }
    creatingAccount = true
    try {
      await api.createAccount(newAccountUsername.trim(), newAccountPassword, newAccountRole)
      newAccountUsername = ''
      newAccountPassword = ''
      newAccountRole = 'normal'
      showCreateAccount = false
      await loadAccounts()
    } catch (err: any) {
      createAccountMessage = { text: err.message || 'Failed to create account.', type: 'error' }
    } finally {
      creatingAccount = false
    }
  }

</script>

<div class="settings-view">
  <div class="settings-container">
    <header class="settings-header">
      <h1>Settings</h1>
      <div class="settings-save">
        <span class="help-text" role="status">{saving ? 'Saving…' : hasChanges ? 'Unsaved changes' : didSave ? 'Changes saved' : ''}</span>
        <button class="primary save-button" disabled={!draft || !hasChanges || saving || !!savePermission}
          title={savePermission ? authStore.control(savePermission).title : undefined} onclick={handleSave}>Save Changes</button>
      </div>
    </header>

    <nav class="tabs" aria-label="Settings categories">
      {#each tabIds as tab (tab)}
        <button type="button" aria-current={activeTab === tab ? 'page' : undefined}
          {...tabControl(tab)}
          onclick={() => (selectedTab = tab)}>
          <Icon name={TABS[tab].icon} size={17} />
          {TABS[tab].label}
        </button>
      {/each}
    </nav>

    <section class="right-column" inert={saving} aria-labelledby="settings-section">
      <h2 id="settings-section" class="content-heading">{activeTab === 'view' ? 'Display Preferences' : TABS[activeTab].label}</h2>
      <div class="content scroll-area">
        <div class="content-limit">
          {#if isSettingsLoading}
            <div class="settings-skeleton">
              {#each [['30%', '0.85em'], ['100%', '2.2rem'], ['30%', '0.85em'], ['100%', '2.2rem'], ['30%', '0.85em'], ['60%', '2.2rem'], ['30%', '0.85em'], ['100%', '2.2rem']] as [w, h]}
                <Skeleton width={w} height={h} />
              {/each}
            </div>
          {:else if !draft}
            <p role="status">Settings could not be loaded. Reopen Settings to retry.</p>
          {:else if activeTab === 'playback'}
            <PlaybackSettingsForm
              canEditServer={authStore.can.editSettings}
              conversionAvailable={playbackConversionAvailable}
              bind:conversion={draft.playbackConversion}
              bind:defaultQuality={draft.defaultPlaybackQuality}
              bind:qualities={draft.playbackQualities}
              bind:encoding={draft.playbackEncoding}
              onManagePlayers={() => (editor = { type: 'players' })}
            />
          {:else if activeTab === 'general'}
            <div class="form-section">
              <div class="settings-action-row">
                <div>
                  <h2>Custom actions</h2>
                  <p class="help-text">{draft.customActions.length === 0 ? 'No actions configured' :
                    `${draft.customActions.length} ${draft.customActions.length === 1 ? 'action' : 'actions'} configured`}</p>
                </div>
                <button class="secondary" onclick={() => (editor = { type: 'actions' })}>Manage actions</button>
              </div>
              <div class="form-group">
                <label for="tmdb-api-key">TMDB API Key</label>
                <input
                  type="password"
                  id="tmdb-api-key"
                  bind:value={draft.tmdbApiKey}
                  placeholder="Enter your TMDB API Key"
                />
                <p class="help-text">
                  Used to fetch metadata and images for movies and TV shows from The Movie Database.
                </p>
              </div>
            </div>

            <div class="form-section">
              <h2>Server Configuration</h2>
              <p class="help-text">Configure how the server is accessed on your network.</p>
              <div class="form-group">
                <label for="server-host">Listen Address</label>
                <input
                  type="text"
                  id="server-host"
                  bind:value={draft.serverHost}
                  placeholder="e.g. 0.0.0.0 or localhost"
                />
                <p class="help-text">
                  Set to <b>::</b> or <b>0.0.0.0</b> to listen on all network interfaces. Use
                  <b>127.0.0.1</b> if you are using a reverse proxy (like Caddy) on the same machine
                  for better security.
                </p>
              </div>
              <div class="form-group">
                <label for="server-port">Server Port</label>
                <input type="number" id="server-port" bind:value={draft.serverPort} min="1" max="65535" />
                <p class="help-text">
                  The network port the server will listen on. Default is 3000. Changes require a
                  restart.
                </p>
              </div>
            </div>
          {:else if activeTab === 'library'}
            <div class="form-section">
              <LibrarySettingsForm
                bind:mediaSources={draft.mediaSources}
                bind:libraryLocation={draft.libraryLocation}
                bind:shadowSources={draft.shadowSources}
                bind:shadowMinDepth={draft.shadowMinDepth}
              />
            </div>
            <div class="form-section">
              <div class="form-group checkbox-group">
                <label>
                  <input type="checkbox" bind:checked={draft.refetchRemoteMetadataOnFileChange} />
                  Refetch remote metadata on file change
                </label>
                <p class="help-text">Refresh TMDB metadata for the affected movie, show, and season on rescan.</p>
              </div>
              <h3>Folder Settings</h3>
              <p class="help-text">Configure metadata retrieval for each folder in your library.</p>
              <LibraryTreeBrowser bind:folderDrafts />
            </div>
          {:else if activeTab === 'view'}
            <div class="form-section">
              <div class="form-group checkbox-group">
                <label class="checkbox-label" for="show-logos">
                  <input type="checkbox" id="show-logos" bind:checked={draft.useLogos} />
                  <span>Show title logos instead of text where possible</span>
                </label>
                <label class="checkbox-label" for="gray-watched">
                  <input type="checkbox" id="gray-watched" bind:checked={draft.grayOutWatched} />
                  <span>Gray out watched items in lists</span>
                </label>
              </div>
              <div class="form-group">
                <label for="credits-display">Cast & Crew Display</label>
                <select id="credits-display" bind:value={draft.creditsDisplay}>
                  <option value="shown">Show Expanded</option>
                  <option value="collapsed">Show Collapsed</option>
                  <option value="tab">Separate Tab</option>
                  <option value="hidden">Hidden</option>
                </select>
                <p class="help-text">
                  Controls how the credits/cast section is displayed in details.
                </p>
              </div>
              <div class="form-group">
                <label for="backdrop-size">Backdrop Size</label>
                <select id="backdrop-size" bind:value={draft.itemDetailBackdropSize}>
                  <option value="small">Standard (Top Header)</option>
                  <option value="full">Full Screen Overflow</option>
                </select>
                <p class="help-text">Sets the layout of the background image in item details.</p>
              </div>
              <div class="form-group">
                <label for="backdrop-blur">Detail Backdrop Blur ({draft.itemDetailBackdropBlur}px)</label>
                <div class="slider-container">
                  <input
                    type="range"
                    id="backdrop-blur"
                    bind:value={draft.itemDetailBackdropBlur}
                    min="0"
                    max="50"
                  />
                  <span class="value-display">{draft.itemDetailBackdropBlur}px</span>
                </div>
                <p class="help-text">Controls the amount of blur applied to background images.</p>
              </div>
              <div class="form-group checkbox-group">
                <label class="checkbox-label" for="show-continue">
                  <input type="checkbox" id="show-continue" bind:checked={draft.showContinueWatching} />
                  <span>Show "Continue Watching" on library screens</span>
                </label>
                <label class="checkbox-label" for="show-next-up">
                  <input type="checkbox" id="show-next-up" bind:checked={draft.showNextUp} />
                  <span>Show "Next Up" in TV show details</span>
                </label>
              </div>
            </div>

            <div class="form-section">
              <h2>Layout Defaults</h2>
              <p class="help-text">Folders can override these defaults.</p>
              <div class="layout-options-list">
                <button
                  class="view-config-row"
                  onclick={() => (editor = { type: 'layout' })}
                  title="Configure Global Layout Defaults"
                >
                  <span>Global Layout Settings</span>
                  <span class="layout-row-arrow"><Icon name="right" size={16} /></span>
                </button>
                {#if draft.defaultLayouts}
                  {#each layoutKeys as key (key)}
                    {@const config = DEFAULT_LAYOUTS_CONFIG[key]}
                    <button
                      class="view-config-row"
                      onclick={() => (editor = { type: 'view', key })}
                      title={`Configure ${config.label} default layout`}
                    >
                      <span>{config.label}</span>
                      <span class="layout-value">{formatLayoutString(draft.defaultLayouts[key])}</span>
                      <span class="layout-row-arrow"><Icon name="right" size={16} /></span>
                    </button>
                  {/each}
                {/if}
              </div>
            </div>
          {:else if activeTab === 'virtualTags'}
            <div class="form-section">
              <p class="help-text">
                Virtual tags are calculated automatically based on rules. Can be used to search,
                filter, and group items.
              </p>
              <div class="virtual-tags-list">
                {#each draft.virtualTags as tag (tag.id)}
                  <div class="vtag-row">
                    <span class="vtag-name">{tag.name}</span>
                    <div class="vtag-actions">
                      <button class="secondary" onclick={() => (editor = { type: 'tag', tag })}>Edit</button>
                      <button class="danger" onclick={() => {
                        if (draft) draft.virtualTags = draft.virtualTags.filter((entry) => entry.id !== tag.id)
                      }}>Delete</button>
                    </div>
                  </div>
                {/each}
              </div>
              <button class="secondary" onclick={() => (editor = {
                type: 'tag',
                tag: {
                  id: crypto.randomUUID(),
                  name: '',
                  cases: [{ filter: { conditionGroups: [[{ field: 'genre', op: 'contains', value: '' }]] }, result: '' }]
                }
              })}>+ Add Virtual Tag</button>
            </div>
          {:else if activeTab === 'accounts'}
            <div class="form-section">
              <h2>Your Account</h2>
              {#if authStore.account}
                {@const acct = authStore.account}
                <button class="account-item clickable" onclick={() => openAccountModal(acct, true)}>
                  <div class="account-info">
                    <div class="account-avatar">{acct.username[0].toUpperCase()}</div>
                    <div class="account-details">
                      <span class="account-name">{acct.username}</span>
                      <span class="account-role">{acct.role === 'admin' ? 'Administrator' : 'Normal'}</span>
                    </div>
                  </div>
                  <span class="account-edit-hint">Edit...</span>
                </button>
              {/if}
            </div>

            {#if authStore.can.manageAccounts}
              <div class="form-section">
                <h2>All Accounts</h2>
                <div class="accounts-list">
                  {#each allAccounts.filter(a => a.id !== authStore.account?.id) as acct (acct.id)}
                    <button class="account-item clickable" onclick={() => openAccountModal(acct, false)}>
                      <div class="account-info">
                        <div class="account-avatar">{acct.username[0].toUpperCase()}</div>
                        <div class="account-details">
                          <span class="account-name">{acct.username}</span>
                          <span class="account-role">{acct.role === 'admin' ? 'Administrator' : 'Normal'}</span>
                        </div>
                      </div>
                      <span class="account-edit-hint">Edit...</span>
                    </button>
                  {:else}
                    <p class="no-accounts">No other accounts yet.</p>
                  {/each}
                </div>

                {#if showCreateAccount}
                  <div class="create-account-box">
                    <h3>New Account</h3>
                    <div class="form-group">
                      <label for="new-acct-user">Username</label>
                      <input type="text" id="new-acct-user" bind:value={newAccountUsername}
                        placeholder="Username" disabled={creatingAccount} />
                    </div>
                    <div class="form-group">
                      <label for="new-acct-pw">Password</label>
                      <input type="password" id="new-acct-pw" bind:value={newAccountPassword}
                        placeholder="Password" disabled={creatingAccount} />
                    </div>
                    <div class="form-group">
                      <label for="new-acct-role">Role</label>
                      <select id="new-acct-role" bind:value={newAccountRole} disabled={creatingAccount}>
                        <option value="normal">Normal</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </div>
                    {#if createAccountMessage.text}
                      <p class="message" class:success={createAccountMessage.type === 'success'} class:error={createAccountMessage.type === 'error'}>
                        {createAccountMessage.text}
                      </p>
                    {/if}
                    <div class="create-account-actions">
                      <button class="secondary" onclick={() => { showCreateAccount = false; createAccountMessage = { text: '', type: '' } }}>
                        Cancel
                      </button>
                      <button class="primary" onclick={handleCreateAccount} disabled={creatingAccount}>
                        {creatingAccount ? 'Creating...' : 'Create Account'}
                      </button>
                    </div>
                  </div>
                {:else}
                  <button class="secondary" onclick={() => (showCreateAccount = true)}>+ Add Account</button>
                {/if}
              </div>
            {:else}
              <div class="form-section">
                <h2>Account Management</h2>
                <button class="secondary" {...authStore.control('manageAccounts')}>+ Add Account</button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </section>
  </div>
</div>

{#if draft && editor?.type === 'view'}
  {@const t = editor.key}
  {@const c = DEFAULT_LAYOUTS_CONFIG[t]}
  <DefaultViewSettingsModal
    typeKey={t}
    title={c.label}
    initialSettings={draft.defaultLayouts[t]}
    {groupByKeys}
    availableLayouts={c.availableLayouts}
    showClickAction={c.showClickAction}
    settings={previewSettings}
    onClose={closeEditor}
    onDone={(s) => {
      if (draft) draft.defaultLayouts[t] = s
    }}
  />
{:else if draft && editor?.type === 'players'}
  <PlayerCommandsModal
    playerCommands={draft.playerCommands}
    canEditDefinitions={authStore.can.editSettings}
    {enabledPlayerIds}
    onDone={(players, ids) => {
      if (draft) draft.playerCommands = players
      enabledPlayerIds = ids
    }}
    onClose={closeEditor}
  />
{:else if draft && editor?.type === 'actions'}
  <CustomActionsModal
    customActions={draft.customActions}
    onDone={(actions) => { if (draft) draft.customActions = actions }}
    onClose={closeEditor}
  />
{:else if draft && editor?.type === 'tag'}
  <VirtualTagModal
    tag={editor.tag}
    {suggestions}
    onClose={closeEditor}
    onDone={(updated) => {
      if (!draft) return
      const index = draft.virtualTags.findIndex((tag) => tag.id === updated.id)
      if (index === -1) draft.virtualTags.push(updated)
      else draft.virtualTags[index] = updated
    }}
  />
{:else if draft && editor?.type === 'layout'}
  <DefaultLayoutSettingsModal
    initialSettings={draft.defaultLayoutSettings}
    settings={previewSettings}
    onClose={closeEditor}
    onDone={(s) => { if (draft) draft.defaultLayoutSettings = s }}
  />
{/if}
{#if editingAccount}
  <AccountModal
    account={editingAccount}
    isSelf={editingAccountIsSelf}
    onClose={() => (editingAccount = null)}
    onSaved={loadAccounts}
  />
{/if}

<style>
  .settings-view {
    height: 100%;
    background: var(--color-background);
  }

  .settings-container {
    --settings-margin: clamp(1rem, 3.2vw, 3.25rem);
    display: grid;
    grid-template-columns: 10.75rem minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    column-gap: var(--settings-margin);
    height: 100%;
    max-width: 1290px;
    margin-inline: auto;
    padding-inline: var(--settings-margin);
  }

  .settings-header {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: .5rem 1rem;
    flex-wrap: wrap;
    padding-block: clamp(1.5rem, 4.5vw, 3.75rem) 1.35rem;
    border-bottom: 1px solid var(--color-border-soft);
    margin-bottom: 1.5rem;
  }

  .settings-save {
    display: flex;
    align-items: center;
    gap: .75rem;
  }

  .settings-header h1 {
    font-size: clamp(1.65rem, 3.5vw, 2.5rem);
    font-weight: 680;
    letter-spacing: -.04em;
  }

  .tabs {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: .3rem;
    align-self: start;
    overflow: auto;
    max-height: 100%;
    padding: 2px;
  }

  .tabs button {
    display: flex;
    align-items: center;
    gap: .65rem;
    padding: .6rem .75rem;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-text-soft);
    text-align: left;
    white-space: nowrap;
  }

  .tabs button:enabled:hover {
    background: var(--color-background-soft);
    color: var(--color-text);
  }

  .tabs button[aria-current="page"] {
    color: var(--color-primary-soft);
    background: var(--accent-surface);
    border-color: var(--accent-border);
    box-shadow: var(--edge-light);
  }

  .right-column {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .content-heading {
    font-size: 1.35rem;
    font-weight: 650;
    margin-block: .25rem .9rem;
  }

  .content {
    overflow-y: auto;
    padding: .15rem .35rem 2rem .15rem;
  }

  .content-limit {
    max-width: 884px;
    display: grid;
    gap: .9rem;
  }

  @media (max-width: 800px) {
    .settings-container { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
    .settings-header { margin-bottom: .75rem; }
    .tabs { flex-direction: row; margin-bottom: .65rem; }
    .tabs button { flex: none; }
  }

  .form-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: clamp(.8rem, 2vw, 1.35rem);
    background: var(--surface-raised);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-panel);
    box-shadow: var(--edge-light);
  }

  .form-section h2, .form-section h3 {
    font-size: 1.05rem;
    font-weight: 650;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-group label {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .checkbox-group {
    gap: 1rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
  }

  input[type='password'],
  select {
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 1rem;
  }

  .settings-action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: .5rem;
  }

  .help-text {
    font-size: 0.85rem;
    color: var(--color-text-dim);
    margin: 0;
  }

  .layout-options-list { display: grid; gap: .45rem; }

  .view-config-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, auto) 16px;
    align-items: center;
    gap: .55rem;
    padding: .68rem .85rem;
    background: var(--control-face);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-field);
    box-shadow: var(--control-shadow);
    text-align: start;
  }

  .view-config-row:hover { border-color: var(--accent-border); }
  .view-config-row:active { box-shadow: var(--control-pressed); }
  .layout-value { max-width: 10rem; color: var(--color-text-soft); font-weight: 500; text-align: end; overflow-wrap: anywhere; }
  .layout-row-arrow { grid-column: 3; display: flex; color: var(--color-text-dim); }
  .view-config-row:hover .layout-row-arrow { color: var(--color-primary-soft); }

  .virtual-tags-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .vtag-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    border-radius: 6px;
  }

  .vtag-name {
    font-weight: 500;
  }

  .vtag-actions {
    display: flex;
    gap: 0.5rem;
  }

  /* Note: button styles are inherited from base.css */

  .account-item {
    padding: 1rem;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .account-info {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .account-avatar {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-field);
    background: var(--accent-surface);
    color: var(--color-primary-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 1.2rem;
  }

  .account-details {
    display: flex;
    flex-direction: column;
  }

  .account-name {
    font-weight: 600;
  }

  .account-role {
    font-size: 0.8rem;
    color: var(--color-text-dim);
  }

  .message {
    font-size: 0.9rem;
    margin: 0;
  }

  .message.success {
    color: var(--color-success);
  }

  .message.error {
    color: var(--color-danger);
  }

  .accounts-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .account-item.clickable {
    cursor: pointer;
    transition: background-color 0.15s;
    width: 100%;
    text-align: left;
    color: inherit;
    font-size: inherit;
  }

  .account-item.clickable:hover {
    background-color: var(--color-background-mute);
  }

  .account-edit-hint {
    font-size: 0.85rem;
    color: var(--color-text-dim);
  }

  .no-accounts {
    font-size: 0.9rem;
    color: var(--color-text-dim);
    margin: 0;
    padding: 0.5rem 0;
  }

  .create-account-box {
    margin-top: 0.5rem;
    padding: 1.25rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .create-account-box h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }

  .create-account-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .settings-skeleton {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem 0;
  }
</style>
