<script lang="ts">
  import SearchInput from './SearchInput.svelte'

  let {
    suggestions,
    onQueryChange
  }: {
    suggestions: AutocompleteSuggestions
    onQueryChange: (query: { text: string; tags: { key: string; value: string }[] }) => void
  } = $props()

  let isOpen = $state(false)
  let element = $state<HTMLElement | undefined>()
  let searchInput = $state<HTMLInputElement | undefined>()

  let filterText = $state('')
  let filterTags = $state<{ key: string; value: string }[]>([])
  const filterQuery = $derived({ text: filterText, tags: filterTags })

  $effect(() => {
    onQueryChange(filterQuery)
  })

  $effect(() => {
    if (isOpen && searchInput) {
      searchInput.focus()
    }
  })

  $effect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isOpen && element && !element.contains(event.target as Node)) {
        isOpen = false
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
    }
  })
</script>

<div bind:this={element} class="filter-bar-container" class:open={isOpen}>
  {#if isOpen}
    <SearchInput
      initialQuery={filterQuery}
      {suggestions}
      onQueryChange={(newQuery) => {
        filterText = newQuery.text
        filterTags = newQuery.tags
      }}
      bind:element={searchInput}
    />
  {:else}
    <button
      class="open-filter-btn"
      onclick={(e) => {
        e.stopPropagation()
        isOpen = true
      }}
      title="Filter current view"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <span>Filter</span>
    </button>
  {/if}
</div>

<style>
  .filter-bar-container {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    padding: 0 1.5rem;
    height: 54px; /* Match header height */
    flex-shrink: 0;
  }
  .filter-bar-container.open {
    padding: 0;
    justify-content: center;
    padding: 0.5rem 1rem;
  }
  .open-filter-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background-color: var(--color-background-soft);
    border-radius: 20px;
  }

  /* Style SearchInput when inside filter bar */
  .filter-bar-container :global(.search-box) {
    max-width: 400px;
    height: 38px;
    background-color: var(--color-background-soft);
  }
</style>
