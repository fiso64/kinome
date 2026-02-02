<script lang="ts">
  import { autocompleteState, type AutocompleteItem } from '../../lib/autocomplete-manager'

  let {
    suggestions,
    position,
    onSelect,
    activeIndex
  }: {
    suggestions: AutocompleteItem[]
    position: { top: number; left: number; inputTop: number }
    onSelect: (suggestion: AutocompleteItem) => void
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

  function renderLabel(item: AutocompleteItem) {
    if (!item.matches || item.matches.length === 0) return item.label

    const segments: { text: string; highlight: boolean }[] = []
    let lastIndex = 0

    // Sort matches just in case
    const sortedMatches = [...item.matches].sort((a, b) => a[0] - b[0])

    for (const [start, end] of sortedMatches) {
      if (start > lastIndex) {
        segments.push({ text: item.label.substring(lastIndex, start), highlight: false })
      }
      segments.push({ text: item.label.substring(start, end), highlight: true })
      lastIndex = end
    }

    if (lastIndex < item.label.length) {
      segments.push({ text: item.label.substring(lastIndex), highlight: false })
    }

    return segments
  }
</script>

<div
  bind:this={menuElement}
  class="autocomplete-menu"
  {style}
  onmousedown={(e) => e.preventDefault()}
>
  {#each suggestions as suggestion, i (suggestion.label)}
    {@const rendered = renderLabel(suggestion)}
    <button
      class="suggestion-item"
      class:active={i === activeIndex}
      onclick={() => onSelect(suggestion)}
      onmouseenter={() => autocompleteState.update((s) => ({ ...s, activeIndex: i }))}
    >
      {#if typeof rendered === 'string'}
        {rendered}
      {:else}
        {#each rendered as segment}
          <span class:highlight={segment.highlight}>{segment.text}</span>
        {/each}
      {/if}
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
    font-weight: 400; /* Ensure thin by default */
  }
  .suggestion-item:hover,
  .suggestion-item.active {
    background-color: var(--ev-c-gray-2);
  }

  .highlight {
    color: var(--ev-c-brand-light, #646cff); /* Brighter brand color */
    font-weight: 800; /* Make it pop more */
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
