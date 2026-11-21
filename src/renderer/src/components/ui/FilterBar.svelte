<script lang="ts">
  import type { AutocompleteSuggestions } from '@shared/types'
  import SearchInput from './SearchInput.svelte'
  import Icon from './Icon.svelte'

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
      if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('dialog[open], [aria-modal="true"]'))) {
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

<div class="filter-bar-container glass-surface">
  <span class="filter-icon"><Icon name="filter" size={17} /></span>
  <SearchInput label="Filter current view" bind:query {suggestions} bind:element={searchInput} />
  <button class="icon-button" type="button" onclick={onClose} aria-label="Close filter" title="Close filter (Esc)"><Icon name="close" size={17} /></button>
</div>

<style>
  .filter-bar-container {
    position: absolute;
    inset-block-end: max(.85rem, env(safe-area-inset-bottom));
    inset-inline-start: 50%;
    transform: translateX(-50%);
    z-index: 30;
    width: min(34rem, calc(100% - 1.2rem));
    display: flex;
    align-items: center;
    gap: .4rem;
    padding: .4rem;
    animation: slide-in .15s ease-out;
  }
  .filter-icon { flex: none; display: flex; align-items: center; padding: 0 .18rem 0 .45rem; color: var(--color-primary-soft); }
  @keyframes slide-in { from { opacity: 0; transform: translate(-50%, .5rem); } }
  @media (prefers-reduced-motion: reduce) { .filter-bar-container { animation: none; } }
</style>
