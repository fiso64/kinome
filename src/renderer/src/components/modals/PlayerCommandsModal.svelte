<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { PlayerCommandConfig } from '@shared/types'
  import { api } from '@lib/api'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { BUILTIN_PLAYER_COMMANDS } from '@lib/services/player-launcher.service'
  import { flip } from 'svelte/animate'

  let {
    playerCommands = $bindable(),
    onClose
  }: {
    playerCommands: PlayerCommandConfig[]
    onClose: () => void
  } = $props()

  // --- Handler state ---
  let clientSecret = $state<string | null>(null)
  let handlerTested = $state(false)
  let isTestingHandler = $state(false)
  let testResult = $state<'idle' | 'success' | 'error'>('idle')
  let testErrorMessage = $state('')
  let forceShowSetup = $state(false)
  let copiedId = $state<string | null>(null)
  let isWebSocketConnected = $state(api.getIsWebSocketConnected())

  $effect(() => {
    return api.onWebSocketStatusChanged((connected) => {
      isWebSocketConnected = connected
    })
  })

  // --- Definitions state (server-side: custom players only, no built-ins) ---
  let localServerDefinitions = $state<PlayerCommandConfig[]>([])
  let editCommandId = $state<string | null>(null)
  let formNameForNew = $state('')
  let formCommandForNew = $state('')
  let modalContentRef = $state<HTMLDivElement | null>(null)

  // --- Device state (client-side: ordered enabled player IDs) ---
  let localEnabledPlayerIds = $state<string[]>([])

  $effect(() => {
    const stored = localStorage.getItem('kinome_client_secret')
    clientSecret = stored ?? crypto.randomUUID()
    if (!stored) localStorage.setItem('kinome_client_secret', clientSecret!)

    handlerTested = localStorage.getItem('kinome_handler_tested') === 'true'

    // Strip built-ins from server definitions — they are implicit, not stored server-side
    localServerDefinitions = playerCommands.filter((c) => !c.isBuiltIn)

    // Init client-side selection; ensure built-ins are always present for ordering
    let ids = [...clientSettingsStore.settings.enabledPlayerIds]
    for (const builtin of BUILTIN_PLAYER_COMMANDS) {
      if (!ids.includes(builtin.id)) ids.push(builtin.id)
    }
    localEnabledPlayerIds = ids
  })

  // --- Derived device lists ---
  const enabledDeviceItems = $derived(
    localEnabledPlayerIds
      .map((id) => {
        const builtin = BUILTIN_PLAYER_COMMANDS.find((p) => p.id === id)
        if (builtin) return builtin
        return localServerDefinitions.find((d) => d.id === id) ?? null
      })
      .filter(Boolean) as PlayerCommandConfig[]
  )

  const disabledDeviceItems = $derived(
    localServerDefinitions.filter((d) => !localEnabledPlayerIds.includes(d.id))
  )

  // devDrag sorts enabledDeviceItems directly (not localEnabledPlayerIds) to avoid
  // any indirection that could cause mismatch between what's displayed and what's sorted.
  const devDrag = useDragSort(
    () => enabledDeviceItems,
    (items) => (localEnabledPlayerIds = items.map((p) => p.id))
  )

  // --- Handler test ---
  async function testHandlerConnection() {
    if (!clientSecret) return
    isTestingHandler = true
    testResult = 'idle'
    testErrorMessage = ''
    const sessionId = crypto.randomUUID()

    const cleanup = api.onHandlerTestSuccess((data) => {
      if (data.sessionId === sessionId) {
        cleanup()
        if (timeoutId) clearTimeout(timeoutId)
        isTestingHandler = false
        testResult = 'success'
        handlerTested = true
        localStorage.setItem('kinome_handler_tested', 'true')
      }
    })

    let timeoutId: any = null
    try {
      await api.startHandlerTest(sessionId)
      const handshakeUrl = `${window.location.origin}/api/handler-test/${sessionId}`
      const testUrl = `kinome://test?secret=${encodeURIComponent(clientSecret!)}&url=${encodeURIComponent(btoa(handshakeUrl))}`
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = testUrl
      document.body.appendChild(iframe)
      setTimeout(() => { if (iframe.parentNode) document.body.removeChild(iframe) }, 1000)
      timeoutId = setTimeout(() => {
        cleanup()
        if (isTestingHandler) {
          isTestingHandler = false
          testResult = 'error'
          testErrorMessage = "No response from handler. Make sure it's installed correctly."
        }
      }, 5000)
    } catch (error) {
      cleanup()
      isTestingHandler = false
      testResult = 'error'
      testErrorMessage = 'Failed to start test: ' + (error as Error).message
    }
  }

  function getStatusMessage() {
    if (!isWebSocketConnected) return 'Waiting for server connection (WebSocket offline)...'
    if (isTestingHandler) return 'Testing Connection...'
    if (testResult === 'success') return 'Test Successful'
    if (testResult === 'error') return `${testErrorMessage || 'Test Failed'}`
    if (handlerTested) return 'Local handler installation detected'
    return 'Handler not yet tested'
  }

  function getInstallerCommands() {
    if (!clientSecret) return { windows: '', linux: '' }
    const baseUrl = window.location.origin
    return {
      windows: `irm ${baseUrl}/install-kinome-handler.ps1?secret=${clientSecret} | iex`,
      linux: `curl -fsSL ${baseUrl}/install-kinome-handler.sh | SECRET=${clientSecret} bash`
    }
  }

  // --- Clipboard ---
  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      copiedId = id
      setTimeout(() => { if (copiedId === id) copiedId = null }, 2000)
    } catch (err) {
      console.error('Failed to copy', err)
    }
  }

  // --- Definition management ---
  function handleWindowClick(event: MouseEvent) {
    if (!editCommandId) return
    const target = event.target as HTMLElement
    if (modalContentRef && !modalContentRef.contains(target)) { editCommandId = null; return }
    if (target.tagName !== 'INPUT') editCommandId = null
  }

  function removeDefinition(id: string) {
    localServerDefinitions = localServerDefinitions.filter((c) => c.id !== id)
    localEnabledPlayerIds = localEnabledPlayerIds.filter((eid) => eid !== id)
    if (editCommandId === id) editCommandId = null
  }

  function handleAddDefinition() {
    if (formNameForNew.trim() && formCommandForNew.trim()) {
      localServerDefinitions = [
        ...localServerDefinitions,
        { id: crypto.randomUUID(), name: formNameForNew.trim(), command: formCommandForNew.trim() }
      ]
      formNameForNew = ''
      formCommandForNew = ''
    }
  }

  // --- Device management ---
  function enableOnDevice(id: string) {
    if (!localEnabledPlayerIds.includes(id)) {
      localEnabledPlayerIds = [...localEnabledPlayerIds, id]
    }
  }

  function disableOnDevice(id: string) {
    localEnabledPlayerIds = localEnabledPlayerIds.filter((eid) => eid !== id)
  }



  // --- Save ---
  function handleSave() {
    playerCommands = [...localServerDefinitions]
    clientSettingsStore.update({ enabledPlayerIds: localEnabledPlayerIds })
    onClose()
  }
</script>

<svelte:window onmousedown={handleWindowClick} />

<ModalWindow title="Manage Players" {onClose} onSave={handleSave} maxWidth="900px" zIndex={101}>
  <div class="content" bind:this={modalContentRef}>

    <!-- Handler Status -->
    <div class="test-section">
      <div
        class="connection-status-card"
        class:success={testResult === 'success' || (testResult === 'idle' && handlerTested)}
        class:error={testResult === 'error'}
        class:testing={isTestingHandler}
      >
        <div class="status-info">
          <div class="indicator-dot"></div>
          <div class="status-details">
            <span class="label">Local Handler</span>
            <span class="message">{getStatusMessage()}</span>
          </div>
        </div>
        <div class="test-actions">
          {#if handlerTested}
            <button class="test-action-btn secondary" onclick={() => (forceShowSetup = !forceShowSetup)}>
              {forceShowSetup ? 'Back to Players' : 'Setup Instructions'}
            </button>
          {/if}
          <button
            class="test-action-btn"
            onclick={testHandlerConnection}
            disabled={isTestingHandler || !isWebSocketConnected}
          >
            {#if !isWebSocketConnected}Offline{:else if isTestingHandler}Testing...{:else}Test Connection{/if}
          </button>
        </div>
      </div>
    </div>

    {#if !handlerTested || forceShowSetup}
      <!-- Setup Mode -->
      <div class="setup-mode">
        <h3>Setup Local Player Handler</h3>
        <p>Run this command in your terminal to install the handler:</p>
        <div class="installer-commands">
          <div class="command-block">
            <label>Windows (PowerShell)</label>
            <div class="code-wrapper">
              <input readonly value={getInstallerCommands().windows} class="code-box" />
              <button class="copy-btn" class:copied={copiedId === 'win'} onclick={() => copyToClipboard(getInstallerCommands().windows, 'win')}>
                {copiedId === 'win' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div class="command-block">
            <label>Linux / macOS</label>
            <div class="code-wrapper">
              <input readonly value={getInstallerCommands().linux} class="code-box" />
              <button class="copy-btn" class:copied={copiedId === 'linux'} onclick={() => copyToClipboard(getInstallerCommands().linux, 'linux')}>
                {copiedId === 'linux' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
        <div class="secret-display">
          <label>Your Client Secret:</label>
          <div class="code-wrapper">
            <input readonly value={clientSecret} class="code-box" />
            <button class="copy-btn" class:copied={copiedId === 'secret'} onclick={() => copyToClipboard(clientSecret || '', 'secret')}>
              {copiedId === 'secret' ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        <div class="hint-box">
          <p><strong>Next Steps:</strong></p>
          <ol>
            <li>Copy and run one of the installer commands above</li>
            <li>Click "Test Connection" to verify the installation</li>
            <li>On success, enable players for this device in the panel on the right</li>
          </ol>
        </div>
      </div>
    {:else}
      <!-- Management Mode: two panels -->
      <div class="management-panels">

        <!-- Left: Server-side definitions -->
        <div class="panel">
          <h3>Player Definitions</h3>
          <p class="panel-subtitle">Shared across all devices</p>
          <div class="player-note">
            Disable playlist or media prefetching in external players so queued items are not marked watched early.
            For mpv, use <code>mpv --prefetch-playlist=no &lt;url&gt;</code>.
          </div>

          <div class="definition-list">
            {#each localServerDefinitions as cmd (cmd.id)}
              <div
                class="definition-item"
                class:editing={editCommandId === cmd.id}
                onclick={() => { editCommandId = editCommandId === cmd.id ? null : cmd.id }}
              >
                {#if editCommandId === cmd.id}
                  <div class="edit-inputs">
                    <input
                      type="text"
                      bind:value={cmd.name}
                      placeholder="Player Name"
                      onclick={(e) => e.stopPropagation()}
                      oninput={(e) => { e.stopPropagation(); localServerDefinitions = localServerDefinitions }}
                    />
                    <input
                      type="text"
                      bind:value={cmd.command}
                      placeholder="Command"
                      onclick={(e) => e.stopPropagation()}
                      oninput={(e) => { e.stopPropagation(); localServerDefinitions = localServerDefinitions }}
                    />
                  </div>
                {:else}
                  <div class="definition-details">
                    <div class="definition-name">{cmd.name}</div>
                    <div class="definition-command">{cmd.command}</div>
                  </div>
                {/if}
                <button class="remove-btn" onclick={(e) => { e.stopPropagation(); removeDefinition(cmd.id) }}>
                  <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
                    <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            {/each}

            {#if localServerDefinitions.length === 0}
              <p class="empty-hint">No custom players defined yet.</p>
            {/if}
          </div>

          <div class="add-form">
            <h4>Add Player</h4>
            <input type="text" bind:value={formNameForNew} placeholder="Name (e.g. MPV)" />
            <input type="text" bind:value={formCommandForNew} placeholder="Command (e.g. mpv --prefetch-playlist=no --fullscreen <url>)" />
            <button
              class="primary"
              onclick={handleAddDefinition}
              disabled={!formNameForNew.trim() || !formCommandForNew.trim()}
            >Add</button>
          </div>
        </div>

        <!-- Right: This Device -->
        <div class="panel">
          <h3>This Device</h3>
          <p class="panel-subtitle">Enabled players in priority order — drag to reorder</p>

          <div class="device-list">
            <!-- Enabled items (draggable) -->
            {#each enabledDeviceItems as player, i (player.id)}
              <div
                class="device-item enabled"
                use:devDrag.item={i}
                use:devDrag.handle={i}
                class:drag-placeholder={devDrag.draggedIndex === i}
                animate:flip={{ duration: 200 }}
              >
                <div class="drag-handle">⠿</div>
                <div class="device-item-name">
                  {player.name}
                  {#if i === 0}<span class="badge">Default</span>{/if}
                  {#if player.isBuiltIn}<span class="badge builtin">Always available</span>{/if}
                </div>
                {#if !player.isBuiltIn}
                  <button class="toggle-btn on" onclick={() => disableOnDevice(player.id)}>
                    Enabled
                  </button>
                {/if}
              </div>
            {/each}

            <!-- Disabled custom items -->
            {#each disabledDeviceItems as player (player.id)}
              <div class="device-item disabled">
                <div class="drag-handle inactive">⠿</div>
                <div class="device-item-name">{player.name}</div>
                <button class="toggle-btn off" onclick={() => enableOnDevice(player.id)}>
                  Enable
                </button>
              </div>
            {/each}

            {#if enabledDeviceItems.length <= 1 && disabledDeviceItems.length === 0}
              <p class="empty-hint">Add custom players in the Definitions panel, then enable them here.</p>
            {/if}
          </div>
        </div>

      </div>
    {/if}
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* Handler status (unchanged) */
  .test-section { margin-bottom: 0.5rem; }

  .connection-status-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    height: 56px;
    transition: all 0.3s ease;
  }

  .status-info { display: flex; align-items: center; gap: 1rem; }
  .indicator-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--ev-c-text-3);
    box-shadow: 0 0 0 4px rgba(255,255,255,0.05);
    transition: all 0.3s ease;
  }
  .status-details { display: flex; flex-direction: column; gap: 2px; }
  .status-details .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ev-c-text-3); font-weight: 600; }
  .status-details .message { font-size: 0.9rem; color: var(--ev-c-text-1); font-weight: 500; }
  .test-actions { display: flex; gap: 0.5rem; }
  .test-action-btn { padding: 0.4rem 1rem; font-size: 0.8rem; background: var(--color-background-mute); border: 1px solid transparent; border-radius: 4px; color: var(--ev-c-text-2); cursor: pointer; transition: all 0.2s; }
  .test-action-btn:hover:not(:disabled) { background: var(--ev-c-gray-3); color: var(--ev-c-text-1); }
  .test-action-btn.secondary { background: transparent; border-color: var(--color-background-mute); }
  .test-action-btn.secondary:hover { background: var(--color-background-mute); }
  .connection-status-card.success { border-color: rgba(40,167,69,0.3); background: rgba(40,167,69,0.05); }
  .connection-status-card.success .indicator-dot { background: #28a745; box-shadow: 0 0 8px rgba(40,167,69,0.4); }
  .connection-status-card.error { border-color: rgba(220,53,69,0.3); background: rgba(220,53,69,0.05); }
  .connection-status-card.error .indicator-dot { background: #dc3545; box-shadow: 0 0 8px rgba(220,53,69,0.4); }
  .connection-status-card.testing .indicator-dot { background: var(--ev-c-blue-1); box-shadow: 0 0 8px rgba(0,123,255,0.4); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

  /* Setup mode (unchanged) */
  .setup-mode { display: flex; flex-direction: column; gap: 1.5rem; }
  .setup-mode h3 { margin-bottom: 0.5rem; color: var(--ev-c-text-1); }
  .installer-commands { display: flex; flex-direction: column; gap: 1rem; }
  .command-block { display: flex; flex-direction: column; gap: 0.5rem; }
  .command-block label { font-weight: bold; font-size: 0.9rem; color: var(--ev-c-text-1); }
  .code-wrapper { display: flex; gap: 0.5rem; align-items: center; }
  .code-wrapper .code-box { flex: 1; background: #0d1117; padding: 1rem; border-radius: 8px; font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace; font-size: 0.85rem; color: #e6edf3; border: 1px solid rgba(255,255,255,0.1); outline: none; cursor: text; width: 100%; user-select: text; }
  .code-wrapper .code-box::selection { background: rgba(33,110,241,0.4); }
  .copy-btn { width: 80px; height: 38px; display: flex; align-items: center; justify-content: center; padding: 0; background: var(--ev-c-gray-3); color: var(--ev-c-text-2); border: 1px solid var(--color-background-mute); border-radius: 6px; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  .copy-btn:hover { background: var(--ev-c-gray-2); color: var(--ev-c-text-1); border-color: var(--ev-c-gray-1); }
  .copy-btn.copied { background: rgba(40,167,69,0.15); color: #2ea043; border-color: rgba(40,167,69,0.5); }
  .secret-display { display: flex; flex-direction: column; gap: 0.5rem; padding: 1rem; background: var(--color-background-soft); border-radius: 6px; }
  .secret-display label { font-weight: bold; font-size: 0.9rem; }
  .hint-box { padding: 1rem; background: var(--ev-c-gray-3); border-left: 3px solid var(--ev-c-green-1); border-radius: 4px; }
  .hint-box p { margin-bottom: 0.5rem; }
  .hint-box ol { margin-left: 1.5rem; line-height: 1.6; }

  /* Two-panel management layout */
  .management-panels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    align-items: start;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    padding: 1rem;
  }

  .panel h3 { font-size: 1rem; font-weight: 600; margin: 0; }
  .panel-subtitle { font-size: 0.8rem; color: var(--ev-c-text-3); margin: 0; }
  .player-note {
    padding: 0.6rem 0.75rem;
    background: rgba(255, 193, 7, 0.08);
    border: 1px solid rgba(255, 193, 7, 0.25);
    border-radius: 6px;
    color: var(--ev-c-text-2);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .player-note code {
    color: var(--ev-c-text-1);
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 0.76rem;
  }

  /* Definitions panel */
  .definition-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 280px;
    overflow-y: auto;
  }

  .definition-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--color-background);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .definition-item:hover { border-color: var(--color-background-mute); }
  .definition-item.editing { border-color: var(--ev-c-gray-1); background: var(--ev-c-gray-3); cursor: default; }

  .definition-details { flex: 1; min-width: 0; }
  .definition-name { font-size: 0.9rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .definition-command { font-size: 0.75rem; color: var(--ev-c-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .edit-inputs { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
  .edit-inputs input { padding: 0.4rem 0.5rem; font-size: 0.85rem; background: var(--color-background); border: 1px solid var(--color-background-mute); border-radius: 4px; color: var(--ev-c-text-1); }

  .remove-btn { background: none; border: none; padding: 0; color: var(--ev-c-text-2); width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 50%; cursor: pointer; flex-shrink: 0; }
  .remove-btn:hover { background: var(--ev-c-gray-3); color: #e81123; }

  .add-form { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--color-background-mute); }
  .add-form h4 { font-size: 0.85rem; font-weight: 600; margin: 0; }
  .add-form input { padding: 0.5rem; background: var(--color-background); border: 1px solid var(--color-background-mute); border-radius: 4px; color: var(--ev-c-text-1); font-size: 0.85rem; }
  .add-form .primary { align-self: flex-start; padding: 0.4rem 1rem; font-size: 0.85rem; }
  .add-form .primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .empty-hint { font-size: 0.8rem; color: var(--ev-c-text-3); font-style: italic; padding: 0.5rem 0; }

  /* Device panel */
  .device-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 340px;
    overflow-y: auto;
  }

  .device-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--color-background);
    border: 1px solid transparent;
    border-radius: 4px;
    transition: border-color 0.15s;
  }
  .device-item.enabled { cursor: default; }
  .device-item.disabled { opacity: 0.5; cursor: default; }
  .device-item.drag-placeholder { opacity: 0.25; pointer-events: none; }

  .drag-handle { color: var(--ev-c-text-2); font-size: 1.1rem; padding: 0 0.2rem; flex-shrink: 0; }
  .drag-handle.inactive { opacity: 0.3; }

  .device-item-name {
    flex: 1;
    font-size: 0.9rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .badge {
    font-size: 0.7rem;
    font-weight: normal;
    padding: 0.1rem 0.4rem;
    background: var(--ev-c-gray-2);
    border-radius: 3px;
    color: var(--ev-c-text-2);
    flex-shrink: 0;
  }
  .badge.builtin { background: rgba(40,167,69,0.15); color: #2ea043; }

  .toggle-btn {
    padding: 0.25rem 0.6rem;
    font-size: 0.75rem;
    border-radius: 4px;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s;
  }
  .toggle-btn.on { background: rgba(40,167,69,0.15); color: #2ea043; border: 1px solid rgba(40,167,69,0.3); }
  .toggle-btn.on:hover { background: rgba(220,53,69,0.12); color: #dc3545; border-color: rgba(220,53,69,0.3); }
  .toggle-btn.off { background: var(--color-background-mute); color: var(--ev-c-text-2); border: 1px solid transparent; }
  .toggle-btn.off:hover { background: rgba(40,167,69,0.12); color: #2ea043; border-color: rgba(40,167,69,0.3); }
</style>
