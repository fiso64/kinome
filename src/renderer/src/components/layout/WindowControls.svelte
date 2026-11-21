<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  let isMaximized = $state(false)

  $effect(() => {
    // Get initial state
    window.api.isWindowMaximized().then((status) => {
      isMaximized = status
    })

    const unlisten = window.api.onWindowMaximizedStatus((status) => {
      isMaximized = status
    })

    return () => {
      unlisten()
    }
  })

  function handleMinimize() {
    window.api.minimizeWindow()
  }

  function handleToggleMaximize() {
    window.api.toggleMaximizeWindow()
  }

  function handleClose() {
    window.api.closeWindow()
  }
</script>

<div class="window-controls">
  <button title="Minimize" aria-label="Minimize" onclick={handleMinimize}>
    <Icon name="minus" size={15} />
  </button>
  <button
    title={isMaximized ? 'Restore' : 'Maximize'}
    aria-label={isMaximized ? 'Restore' : 'Maximize'}
    onclick={handleToggleMaximize}
  >
    <Icon name={isMaximized ? 'restore' : 'maximize'} size={15} />
  </button>
  <button title="Close" aria-label="Close" class="close-button" onclick={handleClose}>
    <Icon name="close" size={15} />
  </button>
</div>

<style>
  .window-controls {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    padding-top: .45rem;
    -webkit-app-region: no-drag;
  }

  button {
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 23px;
    padding: 0;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--color-text-soft);
  }

  button:hover { background: var(--color-hover); color: var(--color-text); }
  .close-button:hover { background: var(--color-danger); color: white; }

  @media (max-width: 620px) {
    button :global(svg) { width: 11px; height: 11px; }
  }
</style>
