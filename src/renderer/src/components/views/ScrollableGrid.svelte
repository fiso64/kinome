<script lang="ts">
  import { untrack, type Snippet } from 'svelte'
  import { writable } from 'svelte/store'
  import { horizontalScroller, type HorizontalScrollState } from '@lib/horizontal-scroll'
  import { viewStateStore, getViewKey } from '@lib/view-state-store.svelte'

  let {
    stateKey,
    hasItems,
    horizontal = true,
    fill = false,
    columnWidth,
    showScrollbar,
    children
  }: {
    stateKey: string
    hasItems: boolean
    horizontal?: boolean
    fill?: boolean
    columnWidth?: number | null
    showScrollbar?: boolean
    children: Snippet
  } = $props()

  const persistentState = viewStateStore.get(getViewKey(stateKey), { scrollX: 0 })
  const scrollState = writable<HorizontalScrollState>({ canScrollLeft: false, canScrollRight: false })
  let grid: HTMLDivElement | undefined = $state()

  $effect(() => {
    const element = grid
    if (!horizontal || !element) return
    const scrollX = untrack(() => persistentState.scrollX)
    if (scrollX <= 0) return
    const timer = setTimeout(() => { element.scrollLeft = scrollX }, 0)
    return () => clearTimeout(timer)
  })

  function scroll(direction: 'left' | 'right') {
    grid?.dispatchEvent(new CustomEvent('smooth-scroll', { detail: { direction } }))
  }
</script>

{#snippet arrow(direction: 'left' | 'right', visible: boolean)}
  <button
    type="button"
    class="scroll-button {direction}"
    class:visible
    aria-label={`Scroll ${direction}`}
    onclick={() => scroll(direction)}
  >
    <svg width="8" height="13" viewBox="0 0 10 16" fill="none" aria-hidden="true">
      <path d={direction === 'left' ? 'M8.5 15L1.5 8L8.5 1' : 'M1.5 1L8.5 8L1.5 15'}
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
{/snippet}

<div class="grid-container" class:horizontal class:fill
  class:can-scroll-left={hasItems && horizontal && $scrollState.canScrollLeft}
  class:can-scroll-right={hasItems && horizontal && $scrollState.canScrollRight}
>
  {#if hasItems}
    {#if horizontal}{@render arrow('left', $scrollState.canScrollLeft)}{/if}
    {#key horizontal}
      <div
        class="media-grid"
        class:with-scrollbar={horizontal && showScrollbar}
        bind:this={grid}
        style:--column-width={columnWidth ? `${columnWidth}px` : undefined}
        use:horizontalScroller={horizontal ? scrollState : undefined}
        onscroll={(event) => {
          if (horizontal) persistentState.scrollX = event.currentTarget.scrollLeft
        }}
      >
        {@render children()}
      </div>
    {/key}
    {#if horizontal}{@render arrow('right', $scrollState.canScrollRight)}{/if}
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>

<style>
  .grid-container {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .grid-container.fill {
    flex: 1;
  }
  .grid-container.horizontal {
    flex-direction: row;
    align-items: center;
    padding: 1.5rem 0;
  }
  .empty-message {
    padding: 1.5rem;
    color: var(--ev-c-text-2);
  }
  .grid-container:not(.horizontal) .media-grid {
    grid-template-columns: repeat(auto-fill, minmax(var(--column-width, var(--grid-poster-size)), 1fr));
    padding: 1.5rem;
    align-content: start;
    flex: 1;
  }
  .fill.horizontal .media-grid,
  .horizontal .media-grid.with-scrollbar {
    padding-bottom: 1rem;
  }
  .media-grid {
    display: grid;
    gap: 1.5rem;
    width: 100%;
  }
  .horizontal .media-grid {
    grid-auto-flow: column;
    grid-auto-columns: var(--column-width, 250px);
    padding: 0.5rem 1.5rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .media-grid::-webkit-scrollbar {
    display: none;
  }
  .horizontal .media-grid.with-scrollbar {
    scrollbar-width: thin;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar {
    display: block;
    height: 8px;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-thumb {
    background-color: var(--ev-c-gray-3);
    border-radius: 4px;
  }
  .media-grid.with-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: var(--ev-c-gray-2);
  }

  .scroll-button {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 3;
    background-color: rgba(30, 30, 30, 0.9);
    backdrop-filter: blur(2px);
    color: var(--ev-c-text-2);
    border: 1px solid var(--color-background-mute);
    border-radius: 50%;
    width: 40px;
    height: 40px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    line-height: 1;
    padding: 0;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 0.2s ease,
      visibility 0.2s ease,
      color 0.2s ease;
  }
  .scroll-button.left {
    left: 1rem;
  }
  .scroll-button.right {
    right: 1rem;
  }
  .grid-container:hover .scroll-button.visible,
  .grid-container:focus-within .scroll-button.visible {
    opacity: 1;
    visibility: visible;
  }
  .scroll-button:hover {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  .scroll-button:active {
    /* Maintain centering but add subtle press effect */
    transform: translateY(-50%) scale(0.95);
  }

  /* Fade Gradients */
  .grid-container.horizontal::before,
  .grid-container.horizontal::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 80px;
    z-index: 2;
    pointer-events: none;
    opacity: 0;
  }

  .grid-container.horizontal::before {
    left: 0;
    background: linear-gradient(to right, var(--color-background) 20%, transparent);
  }
  .grid-container.horizontal::after {
    right: 0;
    background: linear-gradient(to left, var(--color-background) 20%, transparent);
  }
  .grid-container.can-scroll-left::before,
  .grid-container.can-scroll-right::after {
    opacity: 1;
  }
</style>
