<script lang="ts">
  import { api } from '@lib/api'
  import { formatLayoutString } from '@shared/settings-helpers'
  import { dialogStore } from '@lib/dialog-store'
  import DefaultViewSettingsModal from '@modals/DefaultViewSettingsModal.svelte'
  import DefaultLayoutSettingsModal from '@modals/DefaultLayoutSettingsModal.svelte'
  import PlayerCommandsModal from '@modals/PlayerCommandsModal.svelte'
  import CustomActionsModal from '@modals/CustomActionsModal.svelte'
  import VirtualTagEditor from '@modals/_parts/VirtualTagEditor.svelte'
  import LibrarySettingsForm from '@components/settings/LibrarySettingsForm.svelte'
  import { DEFAULT_LAYOUTS_CONFIG } from '@shared/types'
  import type {
    PlayerCommandConfig,
    CustomActionConfig,
    Settings,
    AutocompleteSuggestions
  } from '@shared/types'
  import { navStoreV2 } from '@lib/navigation-store-v2.svelte'
  import { modalStore } from '@lib/modal-store.svelte'
  import { authStore } from '@lib/auth-store.svelte'

  let { settings = $bindable() }: { settings: Settings | null } = $props()

  type ActiveViewSettingsModal = '_default' | 'movie' | 'tv' | 'season' | null

  let activeTab: 'general' | 'library' | 'view' | 'virtualTags' | 'accounts' = $state('general')
  let activeViewSettingsModal = $state<ActiveViewSettingsModal>(null)
  let activeLayoutSettingsModal = $state(false)
  let activePlayerCommandsModal = $state(false)
  let activeCustomActionsModal = $state(false)

  // --- Form State ---
  let playerCommands = $state<PlayerCommandConfig[]>([])
  let customActions = $state<CustomActionConfig[]>([])
  let tmdbApiKey = $state('')
  let useLogos = $state(true)
  let creditsDisplay = $state<'shown' | 'collapsed' | 'hidden' | 'tab'>('tab')
  let grayOutWatched = $state(true)
  let showContinueWatching = $state(true)
  let showNextUp = $state(true)
  let itemDetailBackdropSize = $state<'small' | 'full'>('small')
  let itemDetailBackdropBlur = $state(4)
  let libraryDataLocation = $state('')
  let mediaSourcePath = $state('')
  let mediaSourcePathIsRelative = $state(false)
  let allowUnauthenticated = $state(false)
  let serverPort = $state(3000)
  let allowedIPs = $state<string[]>([])

  let newPassword = $state('')
  let confirmPassword = $state('')
  let passwordMessage = $state({ text: '', type: 'info' })
  let virtualTags = $state<Settings['virtualTags']>([])

  let defaultLayoutSettings = $state<Settings['defaultLayoutSettings'] | null>(null)
  let defaultLayouts = $state<Settings['defaultLayouts'] | null>(null)

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
    api.getSettings().then((s) => {
      playerCommands = JSON.parse(JSON.stringify(s.playerCommands ?? []))
      customActions = JSON.parse(JSON.stringify(s.customActions ?? []))
      tmdbApiKey = s.tmdbApiKey
      useLogos = s.useLogos
      creditsDisplay = s.creditsDisplay
      grayOutWatched = s.grayOutWatched
      showContinueWatching = s.showContinueWatching
      showNextUp = s.showNextUp
      itemDetailBackdropSize = s.itemDetailBackdropSize
      itemDetailBackdropBlur = s.itemDetailBackdropBlur
      virtualTags = (s.virtualTags ?? []).map((vt) => ({
        ...vt,
        id: vt.id || crypto.randomUUID(),
        conditions: vt.conditions || []
      }))
      libraryDataLocation = s.libraryLocation
      mediaSourcePath = s.mediaSourcePath ?? ''
      mediaSourcePathIsRelative = s.mediaSourcePathIsRelative ?? false
      allowUnauthenticated = s.allowUnauthenticated ?? false
      serverPort = s.serverPort ?? 3000
      allowedIPs = s.allowedIPs ?? []

      defaultLayoutSettings = JSON.parse(JSON.stringify(s.defaultLayoutSettings))
      defaultLayouts = JSON.parse(JSON.stringify(s.defaultLayouts))
    })

    api.getAutocompleteSuggestions().then((data) => (suggestions = data))

    const TABS = ['general', 'accounts', 'library', 'view', 'virtualTags'] as const
    const handleKeydown = (event: KeyboardEvent): void => {
      if (activeViewSettingsModal || activeLayoutSettingsModal) return

      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        const currentIndex = TABS.indexOf(activeTab)
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + TABS.length) % TABS.length
          : (currentIndex + 1) % TABS.length
        activeTab = TABS[nextIndex]
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })

  function handleBack() {
    navStoreV2.goBack()
  }

  async function handleSave(): Promise<void> {
    const wasLibLocationChanged = libraryDataLocation !== settings?.libraryLocation
    const mediaPathChanged =
      mediaSourcePath !== settings?.mediaSourcePath ||
      mediaSourcePathIsRelative !== settings?.mediaSourcePathIsRelative

    const plainVirtualTags = JSON.parse(JSON.stringify(virtualTags || []))

    const tagsToSave = plainVirtualTags
      .map((vt) => ({ ...vt, name: vt.name.trim() }))
      .filter((vt) => vt.name && vt.conditions.length > 0)

    await api.saveSettings({
      playerCommands: JSON.parse(JSON.stringify(playerCommands)),
      customActions: JSON.parse(JSON.stringify(customActions)),
      tmdbApiKey,
      useLogos,
      creditsDisplay,
      grayOutWatched,
      showContinueWatching,
      showNextUp,
      itemDetailBackdropSize,
      itemDetailBackdropBlur,
      virtualTags: tagsToSave,
      libraryLocation: libraryDataLocation,
      mediaSourcePath,
      mediaSourcePathIsRelative,
      allowUnauthenticated,
      serverPort,
      allowedIPs,
      defaultLayoutSettings: defaultLayoutSettings
        ? JSON.parse(JSON.stringify(defaultLayoutSettings))
        : undefined,
      defaultLayouts: defaultLayouts ? JSON.parse(JSON.stringify(defaultLayouts)) : undefined
    })

    if (wasLibLocationChanged) {
      return
    }

    if (mediaPathChanged) {
      const choice = await dialogStore.showDialog({
        title: 'Media Source Path Changed',
        message: 'How do you want to proceed?',
        detail:
          'A "Full Rescan" is for new libraries and wipes all metadata. A "Refresh" syncs changes for the existing library.',
        buttons: [
          { label: 'Do Nothing', value: 'nothing', class: 'secondary' },
          { label: 'Full Rescan (Wipe)', value: 'full_rescan', class: 'danger' },
          { label: 'Refresh (Sync)', value: 'rescan', class: 'primary' }
        ]
      })
      if (choice === 'full_rescan') {
        const resolved = await api.resolveMediaSourcePath({
          path: mediaSourcePath,
          isRelative: mediaSourcePathIsRelative
        })
        await api.performScan({ path: resolved })
        // Fetch new root status to get ID
        const status = await api.getLibraryRoot()
        if (status.root) {
          modalStore.open('initialFolderSettings', { root: status.root })
        }
      } else if (choice === 'rescan') {
        await api.performScan()
      }
    }

    handleBack()
  }

  async function handleChangePassword() {
    if (!newPassword) {
      passwordMessage = { text: 'Password cannot be empty', type: 'error' }
      return
    }
    if (newPassword !== confirmPassword) {
      passwordMessage = { text: 'Passwords do not match', type: 'error' }
      return
    }

    try {
      await api.changePassword(newPassword)
      passwordMessage = { text: 'Password changed successfully. Logging out...', type: 'success' }
      newPassword = ''
      confirmPassword = ''

      // Force logout and reload after a short delay
      setTimeout(() => {
        authStore.logout()
        window.location.reload()
      }, 2000)
    } catch (err) {
      passwordMessage = { text: 'Failed to change password', type: 'error' }
    }
  }
</script>

<div class="settings-view">
  <header>
    <div class="header-left">
      <button class="icon-button back-button" onclick={handleBack} aria-label="Back">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path
            fill="currentColor"
            d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
          />
        </svg>
      </button>
      <h1>Settings</h1>
    </div>
    <div class="tabs">
      <button class:active={activeTab === 'general'} onclick={() => (activeTab = 'general')}
        >General</button
      >
      <button class:active={activeTab === 'accounts'} onclick={() => (activeTab = 'accounts')}
        >Accounts</button
      >
      <button class:active={activeTab === 'library'} onclick={() => (activeTab = 'library')}
        >Library</button
      >
      <button class:active={activeTab === 'view'} onclick={() => (activeTab = 'view')}>View</button>
      <button class:active={activeTab === 'virtualTags'} onclick={() => (activeTab = 'virtualTags')}
        >Virtual Tags</button
      >
    </div>
    <div class="actions">
      <button class="primary" onclick={handleSave}>Save Changes</button>
    </div>
  </header>

  <div class="content scroll-area">
    <div class="content-limit">
      {#if activeTab === 'general'}
        <div class="form-section">
          <h2>Player & Metadata</h2>
          <div class="form-group">
            <span id="player-commands-label" class="label">Player Commands</span>
            <div class="path-display-container">
              <div
                id="player-commands"
                class="path-display"
                aria-labelledby="player-commands-label"
              >
                {playerCommands.length} command(s) configured
              </div>
              <button class="secondary" onclick={() => (activePlayerCommandsModal = true)}
                >Manage...</button
              >
            </div>
            <p class="help-text">
              Configure external players to launch when clicking a file. The first one in the list
              is used for the default play action.
            </p>
          </div>
          <div class="form-group">
            <span id="custom-actions-label" class="label">Custom Actions</span>
            <div class="path-display-container">
              <div id="custom-actions" class="path-display" aria-labelledby="custom-actions-label">
                {customActions.length} action(s) configured
              </div>
              <button class="secondary" onclick={() => (activeCustomActionsModal = true)}
                >Manage...</button
              >
            </div>
            <p class="help-text">
              Define custom scripts or commands that can be triggered from the context menu of
              items.
            </p>
          </div>
          <div class="form-group">
            <label for="tmdb-api-key">TMDB API Key</label>
            <input
              type="password"
              id="tmdb-api-key"
              bind:value={tmdbApiKey}
              placeholder="Enter your TMDB API Key"
            />
            <p class="help-text">
              Used to fetch metadata and images for movies and TV shows from The Movie Database.
            </p>
          </div>
        </div>
      {:else if activeTab === 'library'}
        <div class="form-section">
          <h2>Storage Locations</h2>
          <LibrarySettingsForm
            bind:mediaSourcePath
            bind:mediaSourcePathIsRelative
            bind:libraryLocation={libraryDataLocation}
          />
        </div>
      {:else if activeTab === 'view'}
        <div class="form-section">
          <h2>Display Preferences</h2>
          <div class="form-group checkbox-group">
            <label class="checkbox-label" for="show-logos">
              <input type="checkbox" id="show-logos" bind:checked={useLogos} />
              <span>Show title logos instead of text where possible</span>
            </label>
            <label class="checkbox-label" for="gray-watched">
              <input type="checkbox" id="gray-watched" bind:checked={grayOutWatched} />
              <span>Gray out watched items in lists</span>
            </label>
            <p class="help-text">Reduces the opacity of items that have been marked as watched.</p>
          </div>
          <div class="form-group">
            <label for="credits-display">Cast & Crew Display</label>
            <select id="credits-display" bind:value={creditsDisplay}>
              <option value="shown">Show Expanded</option>
              <option value="collapsed">Show Collapsed</option>
              <option value="tab">Separate Tab</option>
              <option value="hidden">Hidden</option>
            </select>
            <p class="help-text">Controls how the credits/cast section is displayed in details.</p>
          </div>
          <div class="form-group">
            <label for="backdrop-size">Backdrop Size</label>
            <select id="backdrop-size" bind:value={itemDetailBackdropSize}>
              <option value="small">Standard (Top Header)</option>
              <option value="full">Full Screen Overflow</option>
            </select>
            <p class="help-text">Sets the layout of the background image in item details.</p>
          </div>
          <div class="form-group">
            <label for="backdrop-blur">Detail Backdrop Blur ({itemDetailBackdropBlur}px)</label>
            <div class="slider-container">
              <input
                type="range"
                id="backdrop-blur"
                bind:value={itemDetailBackdropBlur}
                min="0"
                max="50"
              />
              <span class="value-display">{itemDetailBackdropBlur}px</span>
            </div>
            <p class="help-text">Controls the amount of blur applied to background images.</p>
          </div>
          <div class="form-group checkbox-group">
            <label class="checkbox-label" for="show-continue">
              <input type="checkbox" id="show-continue" bind:checked={showContinueWatching} />
              <span>Show "Continue Watching" on library screens</span>
            </label>
            <label class="checkbox-label" for="show-next-up">
              <input type="checkbox" id="show-next-up" bind:checked={showNextUp} />
              <span>Show "Next Up" in TV show details</span>
            </label>
          </div>
        </div>

        <div class="form-section">
          <h2>Layout Defaults</h2>
          <p class="help-text">
            Configure global default values for specific views and layouts. These can still be
            overridden per-folder.
          </p>
          <button
            class="view-config-row"
            onclick={() => (activeLayoutSettingsModal = true)}
            title="Configure Global Layout Defaults"
          >
            <span>Global Layout Settings</span>
            <span class="secondary">Configure...</span>
          </button>
          {#if defaultLayouts}
            {#each Object.entries(DEFAULT_LAYOUTS_CONFIG) as [key, config] (key)}
              <button
                class="view-config-row"
                onclick={() => (activeViewSettingsModal = key as any)}
                title={`Configure ${config.label} default layout`}
              >
                <span>{config.label}</span>
                <span class="layout-badge">{formatLayoutString(defaultLayouts[key])}</span>
                <span class="secondary">Edit...</span>
              </button>
            {/each}
          {/if}
        </div>
      {:else if activeTab === 'virtualTags'}
        <div class="form-section">
          <h2>Virtual Tags</h2>
          <p class="help-text">
            Virtual tags are calculated automatically based on rules. They are stored in the
            database for fast searching and filtering.
          </p>
          <div class="virtual-tags-list">
            {#each virtualTags as tag, i (tag.id)}
              <VirtualTagEditor
                bind:tag={virtualTags[i]}
                onDelete={() => (virtualTags = virtualTags.filter((t) => t.id !== tag.id))}
              />
            {/each}
          </div>
          <button
            class="secondary add-tag-button"
            onclick={() =>
              (virtualTags = [
                ...virtualTags,
                { id: crypto.randomUUID(), name: '', conditions: [] }
              ])}
          >
            + Add Virtual Tag
          </button>
        </div>
      {:else if activeTab === 'accounts'}
        <div class="form-section">
          <h2>Authentication</h2>
          <div class="form-group checkbox-group">
            <label class="checkbox-label" for="allow-unauthenticated">
              <input
                type="checkbox"
                id="allow-unauthenticated"
                bind:checked={allowUnauthenticated}
              />
              <span>Allow unauthenticated access to the library</span>
            </label>
            <p class="help-text">
              If enabled, anyone can browse and play your media without logging in.
            </p>
          </div>
        </div>

        <div class="form-section">
          <h2>Manage Accounts</h2>
          <div class="account-item">
            <div class="account-info">
              <div class="account-avatar">A</div>
              <div class="account-details">
                <span class="account-name">Admin</span>
                <span class="account-role">Administrator</span>
              </div>
            </div>
          </div>

          <div class="password-change-box">
            <h3>Change Admin Password</h3>
            <div class="form-group">
              <label for="new-password">New Password</label>
              <input
                type="password"
                id="new-password"
                bind:value={newPassword}
                placeholder="Enter new password"
              />
            </div>
            <div class="form-group">
              <label for="confirm-password">Confirm Password</label>
              <input
                type="password"
                id="confirm-password"
                bind:value={confirmPassword}
                placeholder="Confirm new password"
              />
            </div>
            {#if passwordMessage.text}
              <p
                class="message"
                class:success={passwordMessage.type === 'success'}
                class:error={passwordMessage.type === 'error'}
              >
                {passwordMessage.text}
              </p>
            {/if}
            <button class="secondary" onclick={handleChangePassword}>Update Password</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if activeViewSettingsModal && defaultLayouts}
  {@const t = activeViewSettingsModal}
  {@const c = DEFAULT_LAYOUTS_CONFIG[t]}
  <DefaultViewSettingsModal
    typeKey={t}
    title={c.label}
    initialSettings={defaultLayouts[t]}
    {groupByKeys}
    availableLayouts={c.availableLayouts}
    showClickAction={c.showClickAction}
    {settings}
    onClose={() => (activeViewSettingsModal = null)}
    onSave={(s) => {
      if (defaultLayouts) defaultLayouts[t] = s
    }}
  />
{/if}

{#if activePlayerCommandsModal}
  <PlayerCommandsModal bind:playerCommands onClose={() => (activePlayerCommandsModal = false)} />
{/if}
{#if activeCustomActionsModal}
  <CustomActionsModal bind:customActions onClose={() => (activeCustomActionsModal = false)} />
{/if}
{#if activeLayoutSettingsModal}
  <DefaultLayoutSettingsModal
    initialSettings={defaultLayoutSettings}
    {settings}
    {groupByKeys}
    onClose={() => (activeLayoutSettingsModal = false)}
    onSave={(s) => (defaultLayoutSettings = s)}
  />
{/if}

<style>
  .settings-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background-color: var(--color-background);
    color: var(--color-text);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2rem;
    height: 70px;
    background-color: var(--color-background-soft);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .header-left h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  .back-button {
    color: var(--color-text-soft);
  }
  .back-button:hover {
    color: var(--color-text);
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    height: 100%;
  }

  .tabs button {
    padding: 0 1.5rem;
    background: none;
    border: none;
    border-bottom: 3px solid transparent;
    color: var(--color-text-soft);
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .tabs button:hover {
    color: var(--color-text);
  }

  .tabs button.active {
    color: var(--color-primary);
    border-bottom-color: var(--color-primary);
  }

  .content {
    flex-grow: 1;
    overflow-y: auto;
    padding: 2rem;
  }

  .content-limit {
    max-width: 800px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 3rem;
  }

  .form-section {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .form-section h2 {
    font-size: 1.25rem;
    margin: 0;
    color: var(--color-text-dim);
    border-bottom: 1px solid var(--color-border-soft);
    padding-bottom: 0.5rem;
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

  .path-display-container {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .path-display {
    flex-grow: 1;
    padding: 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-family: monospace;
  }

  .help-text {
    font-size: 0.85rem;
    color: var(--color-text-dim);
    margin: 0;
  }

  .view-config-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    cursor: pointer;
    transition: background-color 0.2s;
    width: 100%;
    color: inherit;
    font-size: inherit;
    text-align: left;
  }

  .view-config-row:hover {
    background-color: var(--color-background-mute);
  }

  .virtual-tags-list {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  button.primary {
    background-color: var(--color-primary);
    color: white;
    padding: 0.6rem 1.5rem;
    border-radius: 6px;
    font-weight: 600;
  }

  button.secondary {
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    color: var(--color-text);
  }

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
    border-radius: 50%;
    background-color: var(--color-primary);
    color: white;
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

  .password-change-box {
    margin-top: 1rem;
    padding: 1.5rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .password-change-box h3 {
    margin: 0;
    font-size: 1rem;
    color: var(--color-text);
  }

  .message {
    font-size: 0.9rem;
    margin: 0;
  }

  .message.success {
    color: #4caf50;
  }

  .message.error {
    color: #f44336;
  }
</style>
