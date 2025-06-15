<script lang="ts">
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
    <svg width="12" height="12" viewBox="0 0 12 12"
      ><rect fill="currentColor" width="10" height="1" x="1" y="6"></rect></svg
    >
  </button>
  <button
    title={isMaximized ? 'Restore' : 'Maximize'}
    aria-label={isMaximized ? 'Restore' : 'Maximize'}
    onclick={handleToggleMaximize}
  >
    {#if isMaximized}
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          fill="currentColor"
          d="M2 3v7h7V3H2zm6 6H3V4h5v5zM4 1h5v1H4V1zM3 2h1V1h5v2H3V2z"
        ></path>
      </svg>
    {:else}
      <svg width="12" height="12" viewBox="0 0 12 12"
        ><path fill="currentColor" d="M3 3v6h6V3H3zm5 5H4V4h4v4z"></path></svg
      >
    {/if}
  </button>
  <button title="Close" aria-label="Close" class="close-button" onclick={handleClose}>
    <svg width="12" height="12" viewBox="0 0 12 12"
      ><polygon
        fill="currentColor"
        fill-rule="evenodd"
        points="11 1.576 6.583 6 11 10.424 10.424 11 6 6.583 1.576 11 1 10.424 5.417 6 1 1.576 1.576 1 6 5.417 10.424 1"
      ></polygon></svg
    >
  </button>
</div>

<style>
  .window-controls {
    display: flex;
    -webkit-app-region: no-drag;
    height: 100%;
  }
  button {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    width: 46px;
    height: 100%;
    border: none;
    background-color: transparent;
    color: var(--color-text);
    cursor: pointer;
    padding: 0;
  }
  button:hover {
    background-color: var(--color-background-soft);
  }
  .close-button:hover {
    background-color: #e81123;
    color: white;
  }
</style>
