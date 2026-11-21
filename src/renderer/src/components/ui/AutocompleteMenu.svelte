<script lang="ts">
  import { autocompleteState, type AutocompleteItem } from '@lib/autocomplete-manager'

  let {
    suggestions,
    position,
    onSelect,
    activeIndex,
    loading = false
  }: {
    suggestions: AutocompleteItem[]
    position: { top: number; left: number; inputTop: number }
    onSelect: (suggestion: AutocompleteItem) => void
    activeIndex: number
    loading?: boolean
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

      const left = Math.max(margin, Math.min(position.left, window.innerWidth - menuRect.width - margin))
      style = `top: ${top}px; left: ${left}px; visibility: visible;`
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
  class="autocomplete-menu glass-surface"
  {style}
  onmousedown={(e) => e.preventDefault()}
>
  {#if loading}
    <div class="loading-container">
      <div class="spinner"></div>
      <span class="loading-text">Searching...</span>
    </div>
  {:else}
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
  {/if}
</div>

<style>
  .autocomplete-menu {
    position: fixed;
    padding: .3rem;
    z-index: 300; /* Higher than modal */
    max-height: min(20rem, 55dvh);
    overflow-y: auto;
    width: max-content;
    min-width: 150px;
    max-width: min(28rem, calc(100dvw - 10px));
  }
  .suggestion-item {
    display: block;
    width: 100%;
    padding: .48rem .65rem;
    border-radius: 7px;
    background: none;
    border: none;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 520;

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .suggestion-item:hover,
  .suggestion-item.active {
    background-color: var(--ev-c-gray-2);
  }

  .highlight {
    color: var(--color-primary-soft); /* Brighter brand color */
    font-weight: 800; /* Make it pop more */
  }

  /* --- Loading Spinner --- */
  .loading-container {
    padding: 0.8rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.8rem;
    color: var(--ev-c-gray-1);
    font-size: 0.9rem;
    min-width: 150px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--ev-c-black-mute);
    border-top: 2px solid var(--color-primary-soft);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  .loading-text {
    font-style: italic;
    opacity: 0.8;
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
