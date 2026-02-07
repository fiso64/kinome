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

  // Command management state
  let localPlayerCommands = $state<PlayerCommandConfig[]>([])
  let editCommandId = $state<string | null>(null)
  let formCommandNameForNew = $state('')
  let formCommandStringForNew = $state('')

  // Drag and drop state
  let draggedItemIndex = $state<number | null>(null)
  let dragOverItemIndex = $state<number | null>(null)

  // Load or generate client secret and check if handler was tested
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
      localPlayerCommands = JSON.parse(JSON.stringify(playerCommands))
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

    try {
      // Start test session
      await api.startHandlerTest(sessionId)

      // Construct handshake URL
      const handshakeUrl = `${window.location.origin}/api/handler-test/${sessionId}`
      const encodedUrl = btoa(handshakeUrl)

      // Trigger handler
      const testUrl = `kinome://test?secret=${encodeURIComponent(clientSecret)}&url=${encodeURIComponent(encodedUrl)}`

      // Navigate via hidden iframe
      const iframe = document.createElement('iframe')
      iframe.style.display = 'none'
      iframe.src = testUrl
      document.body.appendChild(iframe)

      // Timeout after 5 seconds
      setTimeout(() => {
        iframe.remove()
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

  function getInstallerCommands() {
    if (!clientSecret) return { windows: '', linux: '' }

    const baseUrl = window.location.origin
    return {
      windows: `irm ${baseUrl}/install-kinome-handler.ps1?secret=${clientSecret} | iex`,
      linux: `curl -fsSL ${baseUrl}/install-kinome-handler.sh | SECRET=${clientSecret} bash`
    }
  }

  // Command management functions
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
    if (index === 0) return // Can't drag the built-in command
    draggedItemIndex = index
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', index.toString())
    }
  }

  function handleDragOver(event: DragEvent, index: number) {
    event.preventDefault()
    if (index === 0) return // Can't drop on built-in command
    if (draggedItemIndex !== null && index !== draggedItemIndex) {
      dragOverItemIndex = index
    }
  }

  function handleDrop(event: DragEvent, dropIndex: number) {
    event.preventDefault()
    if (
      dropIndex === 0 ||
      draggedItemIndex === null ||
      draggedItemIndex === dropIndex ||
      draggedItemIndex === 0
    ) {
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

  // Built-in commands (always present in management mode)
  const builtInCommands: PlayerCommandConfig[] = [
    { id: 'builtin:copy-link', name: 'Copy Playlist Link', command: 'builtin:copy-link' }
  ]

  // Combined commands for display
  let displayCommands = $derived([...builtInCommands, ...localPlayerCommands])
</script>

<ModalWindow
  title="Manage Player Commands"
  {onClose}
  onSave={handleSave}
  maxWidth="800px"
  zIndex={101}
>
  <div class="content">
    <!-- Test Connection Button (Always Visible) -->
    <div class="test-section">
      <button
        class="test-btn"
        class:testing={isTestingHandler}
        class:success={testResult === 'success'}
        class:error={testResult === 'error'}
        onclick={testHandlerConnection}
        disabled={isTestingHandler}
      >
        {#if isTestingHandler}
          Testing Connection...
        {:else if testResult === 'success'}
          ✓ Handler Connected
        {:else if testResult === 'error'}
          ✗ {testErrorMessage || 'Connection Failed'}
        {:else}
          Test Connection
        {/if}
      </button>
    </div>

    {#if !handlerTested}
      <!-- Setup Mode -->
      <div class="setup-mode">
        <h3>Setup Local Player Handler</h3>
        <p>Run this command in your terminal to install the handler:</p>

        <div class="installer-commands">
          <div class="command-block">
            <label>Windows (PowerShell)</label>
            <div class="code-wrapper">
              <code>{getInstallerCommands().windows}</code>
              <button
                class="copy-btn"
                onclick={() => {
                  navigator.clipboard.writeText(getInstallerCommands().windows)
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <div class="command-block">
            <label>Linux / macOS</label>
            <div class="code-wrapper">
              <code>{getInstallerCommands().linux}</code>
              <button
                class="copy-btn"
                onclick={() => {
                  navigator.clipboard.writeText(getInstallerCommands().linux)
                }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>

        <div class="secret-display">
          <label>Your Client Secret:</label>
          <code>{clientSecret}</code>
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
    {:else}
      <!-- Management Mode (Unlocked after successful test) -->
      <div class="management-mode">
        <div class="command-list">
          {#each displayCommands as cmd, i (cmd.id)}
            <div
              class="command-item"
              class:builtin={i === 0}
              class:draggable={i > 0}
              class:dragging-over={dragOverItemIndex === i}
              class:editing={editCommandId === cmd.id}
              draggable={i > 0}
              ondragstart={(e) => handleDragStart(e, i)}
              ondragover={(e) => handleDragOver(e, i)}
              ondragenter={(e) => e.preventDefault()}
              ondrop={(e) => handleDrop(e, i)}
              ondragend={handleDragEnd}
              onclick={() => {
                if (i === 0) return // Can't edit built-in
                if (editCommandId === cmd.id) {
                  editCommandId = null
                } else {
                  editCommandId = cmd.id
                }
              }}
            >
              {#if i > 0}
                <div class="drag-handle">⠿</div>
              {/if}

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
                    {#if i === 0}
                      <span class="badge">Built-in</span>
                    {:else if i === 1}
                      <span class="badge">Default</span>
                    {/if}
                  </div>
                  <div class="command-string">{cmd.command}</div>
                </div>
              {/if}

              {#if i > 0}
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
            placeholder="Command (e.g., mpv --fullscreen [URL])"
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
    display: flex;
    justify-content: center;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--color-background-mute);
  }

  .test-btn {
    padding: 0.75rem 2rem;
    font-size: 1rem;
    font-weight: bold;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    background: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }

  .test-btn:hover:not(:disabled) {
    background: var(--ev-c-gray-1);
  }

  .test-btn.testing {
    background: var(--ev-c-gray-2);
    color: var(--ev-c-text-2);
    cursor: wait;
  }

  .test-btn.success {
    background: #28a745;
    color: white;
  }

  .test-btn.error {
    background: #dc3545;
    color: white;
    font-size: 0.9rem;
    padding: 0.75rem 1.5rem;
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

  .code-wrapper code {
    flex: 1;
    background: var(--color-background-soft);
    padding: 0.75rem;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 0.85rem;
    word-break: break-all;
    overflow-x: auto;
  }

  .copy-btn {
    padding: 0.5rem 1rem;
    background: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .copy-btn:hover {
    background: var(--ev-c-gray-1);
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

  .secret-display code {
    font-family: 'Courier New', monospace;
    font-size: 0.95rem;
    color: var(--ev-c-green-1);
    user-select: all;
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

  .command-item.builtin {
    background-color: var(--ev-c-green-soft);
    border-color: var(--ev-c-green-2);
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
