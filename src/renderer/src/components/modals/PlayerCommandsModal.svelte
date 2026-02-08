<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import type { PlayerCommandConfig } from '@shared/types'
  import { api } from '@lib/api'

  let {
    playerCommands = $bindable(),
    onClose
  }: {
    playerCommands: PlayerCommandConfig[]
    onClose: () => void
  } = $props()

  // Client secret and handler test state
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

  // Command management state
  let localPlayerCommands = $state<PlayerCommandConfig[]>([])
  let editCommandId = $state<string | null>(null)
  let formCommandNameForNew = $state('')
  let formCommandStringForNew = $state('')
  let modalContentRef = $state<HTMLDivElement | null>(null)

  // Stop editing when clicking outside inputs
  function handleWindowClick(event: MouseEvent) {
    if (!editCommandId) return

    const target = event.target as HTMLElement
    // If we clicked outside the modal content or specifically outside an input that isn't the current edit target
    if (modalContentRef && !modalContentRef.contains(target)) {
      editCommandId = null
      return
    }

    // If within modal, check if we clicked an input. If not, stop editing.
    if (target.tagName !== 'INPUT') {
      editCommandId = null
    }
  }

  // Drag and drop state
  let draggedItemIndex = $state<number | null>(null)
  let dragOverItemIndex = $state<number | null>(null)

  // Required built-in commands configuration
  const REQUIRED_BUILT_INS: PlayerCommandConfig[] = [
    {
      id: 'builtin:copy-link',
      name: 'Copy Playlist Link',
      command: 'builtin:copy-link',
      isBuiltIn: true
    }
  ]

  // Initialize commands only if handler is tested
  $effect(() => {
    const stored = localStorage.getItem('kinome_client_secret')
    if (stored) {
      clientSecret = stored
    } else {
      clientSecret = crypto.randomUUID()
      localStorage.setItem('kinome_client_secret', clientSecret)
    }

    // Check if handler was ever successfully tested
    const tested = localStorage.getItem('kinome_handler_tested')
    handlerTested = tested === 'true'

    // Initialize commands only if handler is tested
    if (handlerTested) {
      const commands = JSON.parse(JSON.stringify(playerCommands))

      // Ensure all required built-in commands exist and have correct flags
      for (const builtIn of REQUIRED_BUILT_INS) {
        const idx = commands.findIndex((c) => c.id === builtIn.id)
        if (idx === -1) {
          // Add missing built-in command at the start
          commands.unshift(builtIn)
        } else {
          // Ensure existing command has the flag set (migration)
          commands[idx].isBuiltIn = true
        }
      }

      localPlayerCommands = commands
    }
  })

  // Handler test logic
  async function testHandlerConnection() {
    if (!clientSecret) return

    isTestingHandler = true
    testResult = 'idle'
    testErrorMessage = ''

    const sessionId = crypto.randomUUID()

    // Set up WebSocket listener
    const cleanup = api.onHandlerTestSuccess((data) => {
      if (data.sessionId === sessionId) {
        cleanup()
        if (timeoutId) clearTimeout(timeoutId)
        isTestingHandler = false
        testResult = 'success'
        handlerTested = true
        localStorage.setItem('kinome_handler_tested', 'true')

        // Initialize commands for first-time success
        if (localPlayerCommands.length === 0) {
          localPlayerCommands = JSON.parse(JSON.stringify(playerCommands))
        }
      }
    })

    let timeoutId: any = null

    try {
      // Start test session
      await api.startHandlerTest(sessionId)

      // Construct handshake URL
      const handshakeUrl = `${window.location.origin}/api/handler-test/${sessionId}`
      const encodedUrl = btoa(handshakeUrl)

      // Trigger handler via hidden iframe (standard for protocol triggers)
      const testUrl = `kinome://test?secret=${encodeURIComponent(clientSecret)}&url=${encodeURIComponent(encodedUrl)}`

      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = testUrl
      document.body.appendChild(iframe)

      // Clean up iframe after a moment
      setTimeout(() => {
        if (iframe.parentNode) document.body.removeChild(iframe)
      }, 1000)

      // Timeout after 5 seconds (gives user time to click browser prompt)
      timeoutId = setTimeout(() => {
        cleanup()

        if (isTestingHandler) {
          isTestingHandler = false
          testResult = 'error'
          testErrorMessage =
            "No response from handler. Check for a browser prompt or make sure it's installed correctly."
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

  // Command management functions
  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      copiedId = id
      setTimeout(() => {
        if (copiedId === id) copiedId = null
      }, 2000)
    } catch (err) {
      console.error('Failed to copy', err)
    }
  }

  function removeCommand(id: string) {
    localPlayerCommands = localPlayerCommands.filter((cmd) => cmd.id !== id)
    if (editCommandId === id) {
      editCommandId = null
    }
  }

  function handleAddCommand() {
    if (formCommandNameForNew.trim() && formCommandStringForNew.trim()) {
      localPlayerCommands.push({
        id: crypto.randomUUID(),
        name: formCommandNameForNew.trim(),
        command: formCommandStringForNew.trim()
      })
      localPlayerCommands = [...localPlayerCommands]
      formCommandNameForNew = ''
      formCommandStringForNew = ''
    }
  }

  function handleSave() {
    if (handlerTested) {
      playerCommands = JSON.parse(JSON.stringify(localPlayerCommands))
    }
    onClose()
  }

  // Drag and drop handlers
  function handleDragStart(event: DragEvent, index: number) {
    draggedItemIndex = index
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', index.toString())
    }
  }

  function handleDragOver(event: DragEvent, index: number) {
    event.preventDefault()
    if (draggedItemIndex !== null && index !== draggedItemIndex) {
      dragOverItemIndex = index
    }
  }

  function handleDrop(event: DragEvent, dropIndex: number) {
    event.preventDefault()
    if (draggedItemIndex === null || draggedItemIndex === dropIndex) {
      dragOverItemIndex = null
      return
    }

    const itemToMove = localPlayerCommands[draggedItemIndex]
    localPlayerCommands.splice(draggedItemIndex, 1)
    localPlayerCommands.splice(dropIndex, 0, itemToMove)

    localPlayerCommands = localPlayerCommands
    draggedItemIndex = null
    dragOverItemIndex = null
  }

  function handleDragEnd() {
    draggedItemIndex = null
    dragOverItemIndex = null
  }
</script>

<svelte:window onmousedown={handleWindowClick} />

<ModalWindow
  title="Manage Player Commands"
  {onClose}
  onSave={handleSave}
  maxWidth="800px"
  zIndex={101}
>
  <div class="content" bind:this={modalContentRef}>
    <!-- Test Status Bar -->
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
          <button
            class="test-action-btn secondary"
            onclick={() => (forceShowSetup = !forceShowSetup)}
          >
            {forceShowSetup ? 'Back to Players' : 'Setup Instructions'}
          </button>
          <button
            class="test-action-btn"
            onclick={testHandlerConnection}
            disabled={isTestingHandler || !isWebSocketConnected}
          >
            {#if !isWebSocketConnected}
              Offline
            {:else if isTestingHandler}
              Testing...
            {:else}
              Test Connection
            {/if}
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
              <button
                class="copy-btn"
                class:copied={copiedId === 'win'}
                onclick={() => copyToClipboard(getInstallerCommands().windows, 'win')}
              >
                {copiedId === 'win' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div class="command-block">
            <label>Linux / macOS</label>
            <div class="code-wrapper">
              <input readonly value={getInstallerCommands().linux} class="code-box" />
              <button
                class="copy-btn"
                class:copied={copiedId === 'linux'}
                onclick={() => copyToClipboard(getInstallerCommands().linux, 'linux')}
              >
                {copiedId === 'linux' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        <div class="secret-display">
          <label>Your Client Secret:</label>
          <div class="code-wrapper">
            <input readonly value={clientSecret} class="code-box" />
            <button
              class="copy-btn"
              class:copied={copiedId === 'secret'}
              onclick={() => copyToClipboard(clientSecret || '', 'secret')}
            >
              {copiedId === 'secret' ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <div class="hint-box">
          <p><strong>Next Steps:</strong></p>
          <ol>
            <li>Copy and run one of the installer commands above</li>
            <li>Click "Test Connection" to verify the installation</li>
            <li>On success, you'll be able to manage player commands</li>
          </ol>
        </div>
      </div>
    {:else if handlerTested && !forceShowSetup}
      <!-- Management Mode (Unlocked after successful test) -->
      <div class="management-mode">
        <div class="command-list">
          {#each localPlayerCommands as cmd, i (cmd.id)}
            <div
              class="command-item"
              class:builtin={cmd.isBuiltIn}
              class:draggable={!editCommandId || editCommandId !== cmd.id}
              class:dragging-over={dragOverItemIndex === i}
              class:editing={editCommandId === cmd.id}
              draggable={!editCommandId || editCommandId !== cmd.id}
              ondragstart={(e) => handleDragStart(e, i)}
              ondragover={(e) => handleDragOver(e, i)}
              ondragenter={(e) => e.preventDefault()}
              ondrop={(e) => handleDrop(e, i)}
              ondragend={handleDragEnd}
              onclick={() => {
                if (cmd.isBuiltIn) return // Can't edit built-in
                if (editCommandId === cmd.id) {
                  editCommandId = null
                } else {
                  editCommandId = cmd.id
                }
              }}
            >
              <div class="drag-handle">⠿</div>

              {#if editCommandId === cmd.id}
                <div class="command-edit-inputs">
                  <input
                    type="text"
                    bind:value={cmd.name}
                    placeholder="Player Name"
                    onclick={(e) => e.stopPropagation()}
                    oninput={(e) => {
                      e.stopPropagation()
                      localPlayerCommands = localPlayerCommands
                    }}
                  />
                  <input
                    type="text"
                    bind:value={cmd.command}
                    placeholder="Player Command"
                    onclick={(e) => e.stopPropagation()}
                    oninput={(e) => {
                      e.stopPropagation()
                      localPlayerCommands = localPlayerCommands
                    }}
                  />
                </div>
              {:else}
                <div class="command-details">
                  <div class="command-name">
                    {cmd.name}
                    {#if cmd.isBuiltIn}
                      <span class="badge">Built-in</span>
                    {:else if i === 0}
                      <span class="badge">Default</span>
                    {/if}
                  </div>
                  <div class="command-string">{cmd.command}</div>
                </div>
              {/if}

              {#if !cmd.isBuiltIn}
                <button
                  class="remove-btn"
                  onclick={(e) => {
                    e.stopPropagation()
                    removeCommand(cmd.id)
                  }}
                >
                  ×
                </button>
              {/if}
            </div>
          {/each}
        </div>

        <div class="add-command-form">
          <h4>Add New Player</h4>
          <input
            type="text"
            bind:value={formCommandNameForNew}
            placeholder="Player Name (e.g., MPV)"
          />
          <input
            type="text"
            bind:value={formCommandStringForNew}
            placeholder="Command (e.g., mpv --fullscreen <url>)"
          />
          <div class="form-actions">
            <button
              class="primary add-btn"
              onclick={handleAddCommand}
              disabled={!formCommandNameForNew.trim() || !formCommandStringForNew.trim()}
            >
              Add Player
            </button>
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

  .test-section {
    margin-bottom: 2rem;
  }

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

  .status-info {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .indicator-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ev-c-text-3);
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.05);
    transition: all 0.3s ease;
  }

  .status-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .status-details .label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ev-c-text-3);
    font-weight: 600;
  }

  .status-details .message {
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
    font-weight: 500;
  }

  .test-actions {
    display: flex;
    gap: 0.5rem;
  }

  .test-action-btn {
    padding: 0.4rem 1rem;
    font-size: 0.8rem;
    background: var(--color-background-mute);
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--ev-c-text-2);
    cursor: pointer;
    transition: all 0.2s;
  }

  .test-action-btn:hover:not(:disabled) {
    background: var(--ev-c-gray-3);
    color: var(--ev-c-text-1);
  }

  .test-action-btn.secondary {
    background: transparent;
    border-color: var(--color-background-mute);
  }

  .test-action-btn.secondary:hover {
    background: var(--color-background-mute);
  }

  /* Success State */
  .connection-status-card.success {
    border-color: rgba(40, 167, 69, 0.3);
    background: rgba(40, 167, 69, 0.05);
  }
  .connection-status-card.success .indicator-dot {
    background: #28a745;
    box-shadow: 0 0 8px rgba(40, 167, 69, 0.4);
  }

  /* Error State */
  .connection-status-card.error {
    border-color: rgba(220, 53, 69, 0.3);
    background: rgba(220, 53, 69, 0.05);
  }
  .connection-status-card.error .indicator-dot {
    background: #dc3545;
    box-shadow: 0 0 8px rgba(220, 53, 69, 0.4);
  }

  /* Testing State */
  .connection-status-card.testing .indicator-dot {
    background: var(--ev-c-blue-1);
    box-shadow: 0 0 8px rgba(0, 123, 255, 0.4);
    animation: pulse 1.5s infinite;
  }

  @keyframes pulse {
    0% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
    100% {
      opacity: 0.4;
    }
  }

  /* Setup Mode Styles */
  .setup-mode {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .setup-mode h3 {
    margin-bottom: 0.5rem;
    color: var(--ev-c-text-1);
  }

  .installer-commands {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .command-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .command-block label {
    font-weight: bold;
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
  }

  .code-wrapper {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .code-wrapper .code-box {
    flex: 1;
    background: #0d1117;
    padding: 1rem;
    border-radius: 8px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 0.85rem;
    line-height: normal;
    color: #e6edf3;
    border: 1px solid rgba(255, 255, 255, 0.1);
    outline: none;
    cursor: text;
    width: 100%;
    /* Ensure text selection works perfectly */
    user-select: text;
  }

  .code-wrapper .code-box::selection {
    background: rgba(33, 110, 241, 0.4);
  }

  .copy-btn {
    width: 80px;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--ev-c-gray-3);
    color: var(--ev-c-text-2);
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .copy-btn:hover {
    background: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
    border-color: var(--ev-c-gray-1);
  }

  .copy-btn.copied {
    background: rgba(40, 167, 69, 0.15);
    color: #2ea043;
    border-color: rgba(40, 167, 69, 0.5);
  }

  .secret-display {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem;
    background: var(--color-background-soft);
    border-radius: 6px;
  }

  .secret-display label {
    font-weight: bold;
    font-size: 0.9rem;
  }

  .hint-box {
    padding: 1rem;
    background: var(--ev-c-gray-3);
    border-left: 3px solid var(--ev-c-green-1);
    border-radius: 4px;
  }

  .hint-box p {
    margin-bottom: 0.5rem;
  }

  .hint-box ol {
    margin-left: 1.5rem;
    line-height: 1.6;
  }

  /* Management Mode Styles */
  .management-mode {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .command-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 40vh;
    overflow-y: auto;
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 0.5rem;
    background-color: var(--color-background);
  }

  .command-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background-color: var(--color-background-soft);
    border-radius: 4px;
    border: 1px solid transparent;
    transition: all 0.2s;
  }

  .command-item.draggable {
    cursor: grab;
  }

  .command-item.dragging-over {
    border-color: var(--ev-c-gray-1);
  }

  .command-item.editing {
    background-color: var(--ev-c-gray-3);
    border-color: var(--ev-c-gray-1);
    cursor: default;
  }

  .drag-handle {
    color: var(--ev-c-text-2);
    font-size: 1.2rem;
    padding: 0 0.25rem;
  }

  .command-details {
    flex-grow: 1;
  }

  .command-name {
    font-weight: bold;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .badge {
    font-size: 0.75rem;
    font-weight: normal;
    padding: 0.15rem 0.5rem;
    background: var(--ev-c-gray-2);
    border-radius: 3px;
    color: var(--ev-c-text-2);
  }

  .command-string {
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    word-break: break-all;
  }

  .command-edit-inputs {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .command-edit-inputs input {
    padding: 0.5rem;
    font-size: 0.9rem;
    background: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    color: var(--ev-c-text-1);
  }

  .remove-btn {
    background: none;
    color: var(--ev-c-text-2);
    font-size: 1.5rem;
    padding: 0 0.5rem;
    cursor: pointer;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .remove-btn:hover {
    color: #e81123;
    background-color: var(--ev-c-gray-3);
  }

  .add-command-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-background-mute);
  }

  .add-command-form h4 {
    font-weight: bold;
    margin-bottom: 0.25rem;
  }

  .add-command-form input {
    padding: 0.75rem;
    background: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    color: var(--ev-c-text-1);
  }

  .form-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .add-btn {
    align-self: flex-start;
  }

  .add-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
