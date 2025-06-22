<script lang="ts">
  import { autocompleteState } from '../../lib/autocomplete-manager'

  let {
    suggestions,
    position,
    onSelect,
    onClose,
    activeIndex
  }: {
    suggestions: string[]
    position: { top: number; left: number; inputTop: number }
    onSelect: (suggestion: string) => void
    onClose: () => void
    activeIndex: number
  } = $props()

  let menuElement: HTMLDivElement
  let style = $state('visibility: hidden;')

  $effect(() => {
    if (menuElement) {
      const menuRect = menuElement.getBoundingClientRect()
      const windowHeight = window.innerHeight
      const margin = 5

      let top = position.top // Default to below

      if (top + menuRect.height > windowHeight - margin) {
        // It overflows below, so place it above the input
        const topAbove = position.inputTop - menuRect.height - 4
        // If placing it above would push it off the top of the screen, clamp it.
        top = Math.max(margin, topAbove)
      }

      style = `top: ${top}px; left: ${position.left}px; visibility: visible;`
    }
  })

  $effect(() => {
    // When the active index changes, scroll the active item into view.
    // By reading activeIndex, we make it a reactive dependency.
    if (menuElement && activeIndex !== null) {
      menuElement.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  })
</script>

<div
  bind:this={menuElement}
  class="autocomplete-menu"
  style={style}
  onmousedown={(e) => e.preventDefault()}
>
  {#each suggestions as suggestion, i (suggestion)}
    <button
      class="suggestion-item"
      class:active={i === activeIndex}
      onclick={() => onSelect(suggestion)}
      onmouseenter={() => autocompleteState.update((s) => ({ ...s, activeIndex: i }))}
    >
      {suggestion}
    </button>
  {/each}
</div>

<style>
  .autocomplete-menu {
    position: fixed;
    background-color: var(--ev-c-black-soft);
    border: 1px solid var(--ev-c-black-mute);
    border-radius: 6px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
    z-index: 300; /* Higher than modal */
    max-height: 200px;
    overflow-y: auto;
    width: max-content;
    min-width: 150px;
  }
  .suggestion-item {
    display: block;
    width: 100%;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .suggestion-item:hover,
  .suggestion-item.active {
    background-color: var(--ev-c-gray-2);
  }

  /* --- Custom Scrollbar --- */
  .autocomplete-menu::-webkit-scrollbar {
    width: 8px;
  }
  .autocomplete-menu::-webkit-scrollbar-track {
    background: transparent;
  }
  .autocomplete-menu::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-1);
    border-radius: 4px;
    border: 2px solid var(--ev-c-black-soft); /* Creates padding around thumb */
  }
  .autocomplete-menu::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }
</style>
