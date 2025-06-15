<script lang="ts">
  const placeholderText = 'e.g., mpv {PATH} or "C:\\VLC\\vlc.exe" {PATH}'

  let { close }: { close: () => void } = $props()

  let playerCommand = $state('')
  let tmdbApiKey = $state('')

  $effect(() => {
    window.api.getSettings().then((settings) => {
      playerCommand = settings.playerCommand ?? ''
      tmdbApiKey = settings.tmdbApiKey ?? ''
    })

    const handleKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
    }
  })

  async function handleSave(): Promise<void> {
    await window.api.saveSettings({ playerCommand, tmdbApiKey })
    close()
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
<div
  class="modal-backdrop"
  onclick={(e) => e.target === e.currentTarget && close()}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal-content">
    <h2>Settings</h2>
    <div class="form-group">
      <label for="player-command">Player Command</label>
      <input
        type="text"
        id="player-command"
        bind:value={playerCommand}
        placeholder={placeholderText}
      />
      <p class="help-text">
        Use <code>&lbrace;PATH&rbrace;</code> as a placeholder for the file path.
      </p>
    </div>
    <div class="form-group">
      <label for="tmdb-api-key">The Movie Database (TMDB) API Key</label>
      <input type="password" id="tmdb-api-key" bind:value={tmdbApiKey} />
      <p class="help-text">Required for fetching movie and show posters and details.</p>
    </div>
    <div class="actions">
      <button onclick={handleSave}>Save & Close</button>
      <button class="secondary" onclick={() => close()}>Cancel</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 100;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 2rem;
    border-radius: 8px;
    width: 90%;
    max-width: 500px;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    font-weight: bold;
  }
  input {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family:
      ui-monospace,
      SFMono-Regular,
      SF Mono,
      Menlo,
      Consolas,
      Liberation Mono,
      monospace;
  }
  .help-text {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
  }
  code {
    font-size: 0.8rem;
    padding: 2px 4px;
    background-color: var(--color-background-mute);
    border-radius: 3px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }
  button.secondary {
    background-color: transparent;
    border: 1px solid var(--ev-c-gray-1);
  }
</style>
