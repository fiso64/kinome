<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { flip } from 'svelte/animate'
  import ModalWindow from './_base/ModalWindow.svelte'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import type { PlayerCommandConfig } from '@shared/types'
  import { api } from '@lib/api'
  import { clientSettingsStore } from '@lib/client-settings-store.svelte'
  import { BUILTIN_COPY_LINK, BUILTIN_WEB_PLAYER, resolveClientPlayers } from '@lib/services/player-launcher.service'

  let {
    playerCommands = $bindable(),
    onClose
  }: {
    playerCommands: PlayerCommandConfig[]
    onClose: () => void
  } = $props()

  let definitions = $state(untrack(() => playerCommands
    .filter((command) => !command.isBuiltIn)
    .map((command) => ({ ...command }))))
  let enabledIds = $state(untrack(() => [...clientSettingsStore.settings.enabledPlayerIds]))
  type CommandDraft = { id?: string; name: string; command: string }
  let editor = $state<CommandDraft | null>(null)
  let editorForm = $state<HTMLFormElement>()
  let addPlayerButton = $state<HTMLButtonElement>()
  let selectedId = $state<string | null>(null)
  const canSaveCommand = $derived(Boolean(editor?.name.trim() && editor.command.trim()))
  const originalCommand = $derived(definitions.find((command) => command.id === editor?.id))
  const commandChanged = $derived(Boolean(editor && (
    editor.name !== (originalCommand?.name ?? '') || editor.command !== (originalCommand?.command ?? '')
  )))
  const devicePlayers = $derived(resolveClientPlayers(definitions, enabledIds))
  const selectedPlayer = $derived(devicePlayers.find((player) => player.id === selectedId)
    ?? definitions.find((player) => player.id === selectedId))
  const availablePlayers = $derived.by(() => {
    const enabled = new Set(enabledIds)
    return definitions.filter((command) => !enabled.has(command.id))
  })

  let editorPanel = $state<HTMLElement>()

  const dragSort = useDragSort(
    () => devicePlayers,
    (players) => { enabledIds = players.map((player) => player.id) }
  )

  function movePlayer(index: number, direction: -1 | 1) {
    const next = index + direction
    if (next < 0 || next >= devicePlayers.length) return
    const ids = devicePlayers.map((player) => player.id)
    ;[ids[index], ids[next]] = [ids[next], ids[index]]
    enabledIds = ids
  }

  function enablePlayer(id: string) {
    enabledIds = [...devicePlayers.map((player) => player.id), id]
  }

  function disablePlayer(id: string) {
    enabledIds = devicePlayers.filter((player) => player.id !== id).map((player) => player.id)
  }

  function removeCommand(id: string) {
    definitions = definitions.filter((command) => command.id !== id)
    disablePlayer(id)
    if (selectedId === id) {
      selectedId = null
      editor = null
    }
  }

  function saveCommand() {
    if (!editor || !canSaveCommand) return false
    const command = { id: editor.id ?? crypto.randomUUID(), name: editor.name.trim(), command: editor.command.trim() }
    if (editor.id) {
      definitions = definitions.map((entry) => entry.id === command.id ? command : entry)
      editor = { ...command }
    } else {
      definitions = [...definitions, command]
      enablePlayer(command.id)
      selectedId = null
      editor = null
    }
    return true
  }

  function submitCommand(event: SubmitEvent) {
    event.preventDefault()
    const adding = !editor?.id
    if (saveCommand() && adding) void tick().then(() => addPlayerButton?.focus())
  }

  function applyPendingEdit(): boolean {
    if (!commandChanged || saveCommand()) return true
    editorForm?.reportValidity()
    return false
  }

  async function revealEditor() {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    await tick()
    editorPanel?.scrollIntoView({ block: 'nearest' })
  }

  function selectPlayer(player: PlayerCommandConfig) {
    if (player.id !== selectedId) {
      if (!applyPendingEdit()) return
      selectedId = player.id
      editor = player.isBuiltIn ? null : { ...player }
    }
    void revealEditor()
  }

  async function addPlayer() {
    if (!applyPendingEdit()) return
    selectedId = null
    editor = { name: '', command: '' }
    await tick()
    editorForm?.querySelector('input')?.focus()
  }

  function resetEditor() {
    editor = originalCommand ? { ...originalCommand } : null
  }

  function handleSave() {
    if (!applyPendingEdit()) return
    playerCommands = definitions.map((command) => ({ ...command }))
    clientSettingsStore.update({ enabledPlayerIds: devicePlayers.map((player) => player.id) })
    onClose()
  }

  let handlerTested = $state(localStorage.getItem('kinome_handler_tested') === 'true')
  let isWebSocketConnected = $state(api.getIsWebSocketConnected())
  let isTesting = $state(false)
  let testError = $state('')
  let showInstallers = $state(false)
  let clientSecret = $state(localStorage.getItem('kinome_client_secret') ?? '')
  let copied = $state<string | null>(null)
  let cancelTest: (() => void) | undefined
  let copyTimeout: ReturnType<typeof setTimeout> | undefined

  $effect(() => api.onWebSocketStatusChanged((connected) => { isWebSocketConnected = connected }))

  onDestroy(() => {
    cancelTest?.()
    clearTimeout(copyTimeout)
  })

  function getClientSecret(): string {
    if (!clientSecret) {
      clientSecret = crypto.randomUUID()
      localStorage.setItem('kinome_client_secret', clientSecret)
    }
    return clientSecret
  }

  const handlerStatus = $derived(
    isTesting ? 'Waiting for the handler…'
    : testError || (handlerTested ? 'Handler verified on this device.' : 'Handler setup has not been verified.')
  )

  async function testHandler() {
    const secret = getClientSecret()
    const sessionId = crypto.randomUUID()
    isTesting = true
    testError = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    let frame: HTMLIFrameElement | undefined
    const unsubscribe = api.onHandlerTestSuccess((event) => {
      if (event.sessionId !== sessionId) return
      cleanup()
      handlerTested = true
      localStorage.setItem('kinome_handler_tested', 'true')
    })
    function cleanup() {
      unsubscribe()
      clearTimeout(timeout)
      frame?.remove()
      cancelTest = undefined
      isTesting = false
    }
    cancelTest = cleanup
    try {
      const result = await api.startHandlerTest(sessionId)
      if (cancelTest !== cleanup) return
      if (!result.success) throw new Error('The server could not start the test.')
      const callback = btoa(`${window.location.origin}/api/handler-test/${sessionId}`)
      frame = document.createElement('iframe')
      frame.hidden = true
      frame.src = `kinome://test?secret=${encodeURIComponent(secret)}&url=${encodeURIComponent(callback)}`
      document.body.appendChild(frame)
      timeout = setTimeout(() => {
        cleanup()
        testError = 'No response from the handler. Check the installation and try again.'
      }, 5000)
    } catch (error) {
      if (cancelTest !== cleanup) return
      cleanup()
      testError = error instanceof Error ? error.message : 'Could not start the handler test.'
    }
  }

  const installers = $derived([
    { id: 'windows', label: 'Windows PowerShell', command: `irm ${window.location.origin}/install-kinome-handler.ps1?secret=${clientSecret} | iex` },
    { id: 'linux', label: 'Linux or macOS', command: `curl -fsSL ${window.location.origin}/install-kinome-handler.sh | SECRET=${clientSecret} bash` },
    { id: 'secret', label: 'Client secret', command: clientSecret }
  ])

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      copied = id
    } catch {
      copied = `${id}-error`
    }
    clearTimeout(copyTimeout)
    copyTimeout = setTimeout(() => { copied = null }, 2000)
  }
</script>

{#snippet commandEditor(draft: CommandDraft)}
  <form
    class="command-form"
    bind:this={editorForm}
    onsubmit={submitCommand}
  >
    <label for="player-command-name">Player name</label>
    <input id="player-command-name" bind:value={draft.name} required pattern={'.*\\S.*'} />
    <label for="player-command-template">Launch command</label>
    <input
      id="player-command-template"
      bind:value={draft.command}
      placeholder="mpv --prefetch-playlist=no &lt;url&gt;"
      required
      pattern={'.*\\S.*'}
      aria-describedby="player-command-hint"
    />
    <p id="player-command-hint">Use <code>&lt;url&gt;</code> for the playlist URL. Disable player prefetching to avoid marking queued items watched early.</p>
    <div class="form-actions">
      {#if draft.id}
        {@const id = draft.id}
        <button type="button" class="remove-command" onclick={() => removeCommand(id)}>Remove</button>
      {/if}
      <button type="button" class="secondary compact" disabled={!!draft.id && !commandChanged} onclick={resetEditor}>Cancel edit</button>
      <button type="submit" class="primary compact" disabled={!canSaveCommand || !commandChanged}>{draft.id ? 'Apply' : 'Add'}</button>
    </div>
  </form>
{/snippet}

{#snippet playerCard(player: PlayerCommandConfig, index?: number)}
  <button
    class="player-select"
    data-drag-handle
    aria-pressed={selectedId === player.id}
    aria-label={`Select ${player.name}`}
    onclick={() => selectPlayer(player)}
  >
    <span class="drag-handle" aria-hidden="true">⠿</span>
    <span class="player-name">
      <strong>{player.name}</strong>
      {#if index === 0}<span class="default-tag">Default</span>{/if}
    </span>
  </button>
  <div class="row-actions">
    {#if index === undefined}
      <button class="secondary compact" aria-label={`Enable ${player.name} on this device`} onclick={() => enablePlayer(player.id)}>Enable</button>
    {:else}
      {#if !player.isBuiltIn}
        <button class="quiet-button compact" aria-label={`Disable ${player.name} on this device`} onclick={() => disablePlayer(player.id)}>Disable</button>
      {/if}
      <div class="order-controls">
        <button class="quiet-button icon-button" aria-label={`Move ${player.name} up`} disabled={index === 0} onclick={() => movePlayer(index, -1)}>↑</button>
        <button class="quiet-button icon-button" aria-label={`Move ${player.name} down`} disabled={index === devicePlayers.length - 1} onclick={() => movePlayer(index, 1)}>↓</button>
      </div>
    {/if}
  </div>
{/snippet}

<ModalWindow title="Manage Players" {onClose} onSave={handleSave} maxWidth="860px" zIndex={101}>
  <div class="content">
    <div class="player-grid">
      <section class="panel" aria-labelledby="player-order-heading">
        <header class="panel-header">
          <h3 id="player-order-heading">This device</h3>
          <p>Drag or use the arrows to change the play order.</p>
        </header>
        <ol class="player-list" data-testid="player-order" aria-label="Play order" use:dragSort.dropZone>
          {#each devicePlayers as player, index (player.id)}
            <li
              class="player-row"
              use:dragSort.item={index}
              use:dragSort.handle={index}
              class:selected={selectedId === player.id}
              class:drag-placeholder={dragSort.draggedIndex === index}
              class:insert-before={dragSort.dropIndex === index}
              class:insert-after={dragSort.dropIndex === index + 1 && index === devicePlayers.length - 1}
              animate:flip={{ duration: 180 }}
              data-player-id={player.id}
            >
              {@render playerCard(player, index)}
            </li>
          {/each}
        </ol>
        {#if availablePlayers.length}
          <h4 id="available-players-heading">Available to enable</h4>
          <ul class="player-list" aria-labelledby="available-players-heading">
            {#each availablePlayers as player (player.id)}
              <li
                class="player-row"
                use:dragSort.external={player}
                class:selected={selectedId === player.id}
                class:drag-placeholder={dragSort.externalItem?.id === player.id}
                data-player-id={player.id}
              >
                {@render playerCard(player)}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="panel" aria-labelledby="player-details-heading" bind:this={editorPanel}>
        <header class="panel-header editor-header">
          <h3 id="player-details-heading">{selectedPlayer?.name ?? (editor ? 'New player' : 'Player details')}</h3>
          <button class="secondary compact" bind:this={addPlayerButton} disabled={!!editor && !editor.id} onclick={addPlayer}>Add player</button>
        </header>
        {#if editor}
          <p>Launch commands are shared across devices.</p>
          {@render commandEditor(editor)}
        {:else if selectedPlayer?.id === BUILTIN_WEB_PLAYER.id}
          <p>Plays in this browser. Set startup quality and languages under Web player in Playback settings.</p>
        {:else if selectedPlayer?.isBuiltIn}
          <p>{selectedPlayer.id === BUILTIN_COPY_LINK.id
            ? 'Copies the playback link to your clipboard.'
            : 'Copies a playlist link to your clipboard.'}</p>
        {:else}
          <p>Select a player to view or edit it.</p>
        {/if}
      </section>
    </div>

    <section class="handler-panel" aria-labelledby="player-handler-heading">
      <div class="handler-summary">
        <div class="handler-text">
          <h3 id="player-handler-heading">Local player handler</h3>
          <p class="handler-status" role="status">{handlerStatus}{!isWebSocketConnected ? ' Testing needs a live connection.' : ''}</p>
        </div>
        <div class="handler-actions">
          <button class="secondary compact" onclick={testHandler} disabled={isTesting || !isWebSocketConnected}>Test connection</button>
          <button
            class="secondary compact"
            aria-expanded={showInstallers}
            aria-controls={showInstallers ? 'handler-installers' : undefined}
            onclick={() => {
              if (!showInstallers) getClientSecret()
              showInstallers = !showInstallers
            }}
          >Installation instructions</button>
        </div>
      </div>

      {#if showInstallers}
        <div id="handler-installers" class="installer-list">
          <p>Install the handler on this device to launch custom players.</p>
          {#each installers as installer (installer.id)}
            <div class="installer">
              <label for={`handler-${installer.id}`}>{installer.label}</label>
              <div class="installer-command">
                <input id={`handler-${installer.id}`} readonly value={installer.command} />
                <button class="secondary compact" disabled={!clientSecret} onclick={() => copy(installer.command, installer.id)}>
                  {copied === installer.id ? 'Copied' : copied === `${installer.id}-error` ? 'Copy failed' : 'Copy'}
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
  }

  .player-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr);
    gap: 1rem;
    align-items: start;
  }

  .panel {
    display: grid;
    gap: 0.6rem;
    min-width: 0;
    background: var(--color-background);
    border: 1px solid var(--color-border-soft);
    border-radius: 8px;
    padding: 0.9rem;
  }

  h3 { margin: 0; font-size: 1rem; font-weight: 650; }
  h4 { margin: 0.3rem 0 0; font-size: 0.8rem; font-weight: 600; color: var(--color-text-soft); }
  p { margin: 0; color: var(--color-text-soft); font-size: 0.83rem; }
  .panel-header p, .handler-text p { margin-top: 0.25rem; }

  .editor-header, .handler-summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem 0.75rem;
    flex-wrap: wrap;
  }

  .player-list { display: grid; gap: 0.4rem; list-style: none; padding: 0; margin: 0; }

  .player-row {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.4rem;
    border: 1px solid var(--color-border-soft);
    border-radius: 6px;
    background: var(--color-background-soft);
    touch-action: none;
  }

  .player-row:hover { background: var(--color-background-mute); }
  .player-row.selected, .player-row:has(.player-select:focus-visible) { border-color: var(--color-primary); }
  .player-row.insert-before::before, .player-row.insert-after::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--color-primary);
    pointer-events: none;
  }
  .player-row.insert-before::before { top: -0.26rem; }
  .player-row.insert-after::after { bottom: -0.26rem; }

  .player-select {
    display: flex;
    align-items: center;
    min-height: 2.3rem;
    gap: 0.45rem;
    padding: 0.2rem;
    text-align: left;
    background: transparent;
    cursor: grab;
  }
  .player-select:hover:not(:disabled) { background: transparent; }
  .player-select:active { transform: none; cursor: grabbing; }
  .player-select::after { content: ''; position: absolute; inset: 0; border-radius: 6px; }

  .player-name, .row-actions, .handler-actions, .form-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }
  .player-list strong { font-size: 0.87rem; font-weight: 600; overflow-wrap: anywhere; }
  .row-actions { position: relative; pointer-events: none; }
  .row-actions button { pointer-events: auto; }
  .row-actions, .form-actions { justify-content: flex-end; }
  .compact { padding: 0.35rem 0.6rem; font-size: 0.8rem; }

  .order-controls { display: inline-flex; }
  .quiet-button, .remove-command { background: transparent; }
  .icon-button { min-width: 2rem; min-height: 2rem; padding: 0; }
  .default-tag {
    padding: 0.1rem 0.35rem;
    background: var(--color-background-mute);
    border-radius: 4px;
    font-size: 0.7rem;
  }

  .drag-handle { color: var(--color-text-soft); }
  .drag-placeholder { opacity: 0.25; pointer-events: none; }
  .command-form { display: grid; gap: 0.4rem; width: 100%; padding: 0.4rem 0; }
  .command-form label, .installer label { font-size: 0.83rem; font-weight: 600; }
  .command-form input { min-width: 0; }
  .remove-command { margin-right: auto; color: var(--color-danger); padding: 0.35rem 0.2rem; font-size: 0.8rem; }

  .handler-panel { border-top: 1px solid var(--color-border-soft); padding: 0.9rem 0.2rem 0; }
  .handler-text { flex: 1 1 13rem; }
  .installer-list { display: grid; gap: 0.65rem; margin-top: 0.75rem; }
  .installer { display: grid; gap: 0.25rem; }
  .installer-command { display: flex; gap: 0.4rem; }
  .installer-command input { flex: 1; min-width: 0; font-family: monospace; font-size: 0.82rem; }

  @media (max-width: 760px) {
    .player-grid { grid-template-columns: minmax(0, 1fr); }
  }

  @media (max-width: 480px) {
    .content, .panel { padding: 0.75rem; }
    .content, .player-grid { gap: 0.75rem; }
    .player-row { gap: 0.3rem; }
  }
</style>
