<script lang="ts">
  import type { AutocompleteSuggestions } from '@shared/types'
  import SearchInput from './SearchInput.svelte'

  let {
    query = $bindable(),
    suggestions,
    onClose,
    focusKey
  }: {
    query: { text: string; tags: { key: string; value: string }[] }
    suggestions: AutocompleteSuggestions
    onClose: () => void
    focusKey: number
  } = $props()

  let searchInput = $state<HTMLInputElement | undefined>()

  $effect(() => {
    // This effect runs on mount and whenever focusKey changes.
    void focusKey
    searchInput?.focus()
  })

  $effect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    // Use capture to prevent other escape handlers (like modals) from firing first.
    window.addEventListener('keydown', handleKeydown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeydown, { capture: true })
    }
  })
</script>

<div class="filter-bar-container">
  <SearchInput bind:query {suggestions} bind:element={searchInput} />
  <button class="close-btn" onclick={onClose} title="Close (Esc)">&times;</button>
</div>

<style>
  .filter-bar-container {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50; /* Above content, below modals */

    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background-color: hsla(225, 8%, 15%, 0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid var(--ev-c-black-mute);
    border-radius: 25px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    transition:
      opacity 0.2s,
      transform 0.2s;
    animation: slide-in 0.2s ease-out;
  }

  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translate(-50%, 1rem);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  /* Style SearchInput when inside filter bar */
  .filter-bar-container :global(.search-box) {
    max-width: 500px;
    min-width: 300px;
    height: 38px;
    background-color: transparent;
    border: none;
  }

  .close-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    cursor: pointer;
    font-size: 1.5rem;
    line-height: 1;
    padding: 0 0.5rem;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .close-btn:hover {
    background-color: var(--ev-c-gray-3);
    color: var(--ev-c-text-1);
  }
</style>
