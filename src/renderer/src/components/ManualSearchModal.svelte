<script lang="ts">
  let {
    item,
    onClose
  }: {
    item: LibraryItem
    onClose: () => void
  } = $props()

  type SearchResult = {
    id: number
    title: string
    year: number | null
    poster_path: string
    overview: string
  }
  type TmdbImage = { file_path: string; [key: string]: any }

  let activeTab: 'match' | 'artwork' = $state('match')

  // --- Granular Loading States ---
  let isSearching = $state(false)
  let isFetchingArtwork = $state(false)
  let isSettingImage = $state(false)
  let applyingResultId = $state<number | null>(null)

  // Match tab state
  let searchQuery = $state(item.title ?? item.name)
  let searchYear = $state(item.year?.toString() ?? '')
  let searchType: 'movie' | 'tv' = $state(item.mediaType ?? 'movie')
  let searchResults = $state<SearchResult[]>([])
  let searchInput = $state<HTMLInputElement | undefined>(undefined)

  // Artwork tab state
  let imageLang = $state('en')
  let posters = $state<TmdbImage[]>([])
  let backdrops = $state<TmdbImage[]>([])
  let logos = $state<TmdbImage[]>([])

  async function performSearch() {
    if (!searchQuery.trim() || isSearching) return
    isSearching = true
    searchResults = await window.api.manualSearch(searchQuery, searchType, searchYear)
    isSearching = false
  }

  async function applyResult(result: SearchResult) {
    applyingResultId = result.id
    // De-proxy the reactive Svelte object before sending it over IPC
    const plainResult = JSON.parse(JSON.stringify(result))
    await window.api.applyTmdbResult(item.id, plainResult, searchType)
    // The modal will be closed automatically when the parent receives the item update.
    applyingResultId = null
    onClose()
  }

  async function fetchImages() {
    if (!item.tmdbId || !item.mediaType || isFetchingArtwork) return
    isFetchingArtwork = true
    // Clear old results before fetching new ones
    posters = []
    backdrops = []
    logos = []
    const images = await window.api.getTmdbImages(item.tmdbId, item.mediaType, imageLang)
    posters = images.posters
    backdrops = images.backdrops
    logos = images.logos
    isFetchingArtwork = false
  }

  async function handleRemoveImage(imageType: 'poster' | 'backdrop' | 'logo') {
    isSettingImage = true
    await window.api.removeImage(item.id, imageType)
    // The onLibraryItemUpdated listener will handle the UI refresh.
    isSettingImage = false
  }

  async function handleSetImage(
    imageType: 'poster' | 'backdrop' | 'logo',
    source: { type: 'tmdb'; path: string } | { type: 'local' }
  ) {
    isSettingImage = true
    try {
      if (source.type === 'local') {
        const localPath = await window.api.selectLocalImage()
        if (!localPath) {
          isSettingImage = false
          return // User cancelled dialog, do nothing further.
        }
        await window.api.setImage(item.id, imageType, { type: 'local', path: localPath })
      } else {
        await window.api.setImage(item.id, imageType, JSON.parse(JSON.stringify(source)))
      }
      // The global onLibraryItemUpdated listener in App.svelte will now
      // update the 'item' prop, and this modal's view will update reactively.
    } finally {
      isSettingImage = false
    }
  }

  function horizontalScroll(event: WheelEvent) {
    event.preventDefault()
    const element = event.currentTarget as HTMLElement
    element.scrollLeft += event.deltaY
  }

  // Keyboard shortcut and initial focus
  $effect(() => {
    // Focus the input when the modal opens and the input is rendered
    if (searchInput) {
      searchInput.focus()
    }

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div
  class="modal-backdrop"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="dialog"
  aria-modal="true"
>
  <div class="modal-content">
    <header>
      <h2>Manual Search</h2>
      <div class="tabs">
        <button class:active={activeTab === 'match'} onclick={() => (activeTab = 'match')}
          >Match</button
        >
        <button
          class:active={activeTab === 'artwork'}
          onclick={() => (activeTab = 'artwork')}
          disabled={!item.tmdbId}>Artwork</button
        >
      </div>
    </header>

    <div class="tab-content">
      {#if activeTab === 'match'}
        <form
          class="search-form"
          onsubmit={(e) => {
            e.preventDefault()
            performSearch()
          }}
        >
          <input
            type="text"
            bind:this={searchInput}
            bind:value={searchQuery}
            placeholder="Enter title to search..."
            class="title-input"
          />
          <input
            type="text"
            bind:value={searchYear}
            placeholder="Year"
            class="year-input"
            maxlength="4"
          />
          <select bind:value={searchType}>
            <option value="movie">Movie</option>
            <option value="tv">TV</option>
          </select>
          <button type="submit" disabled={isSearching || !searchQuery.trim()}>
            {#if isSearching}Searching...{:else}Search{/if}
          </button>
        </form>
        <div class="search-results">
          {#each searchResults as result (result.id)}
            <div class="result-item">
              <div class="result-poster">
                {#if result.poster_path}
                  <img src="https://image.tmdb.org/t/p/w154{result.poster_path}" alt="Poster" />
                {/if}
              </div>
              <div class="result-info">
                <h3>{result.title} ({result.year ?? 'N/A'})</h3>
                <p>{result.overview}</p>
              </div>
              <div class="result-actions">
                <button onclick={() => applyResult(result)} disabled={applyingResultId !== null}>
                  {#if applyingResultId === result.id}Applying...{:else}Select{/if}
                </button>
              </div>
            </div>
          {:else}
            {#if !isSearching}
              <p class="empty-text">No results. Try searching above.</p>
            {/if}
          {/each}
        </div>
      {:else if activeTab === 'artwork'}
        <div class="artwork-controls">
          <div>
            <label for="lang-select">Image Language:</label>
            <select id="lang-select" bind:value={imageLang} disabled={isFetchingArtwork}>
              <option value="en">English</option>
              <option value="ja">Japanese</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="none">All (No Language)</option>
            </select>
          </div>
          <button onclick={fetchImages} disabled={isFetchingArtwork}>
            {#if isFetchingArtwork}Finding...{:else}Find Artwork{/if}
          </button>
        </div>

        <div class="image-sections">
          <section>
            <h4>Poster</h4>
            <div class="artwork-container">
              <div class="current-artwork-wrapper">
                <div class="current-image-container">
                  <div class="current-image">
                    {#if item.posterPath}
                      <img
                        src="media-browser-asset://images/{item.posterPath}{item._v
                          ? `?v=${item._v}`
                          : ''}"
                        alt="Current Poster"
                      />
                      <button
                        class="remove-image-btn"
                        title="Remove Poster"
                        onclick={() => handleRemoveImage('poster')}>&times;</button
                      >
                    {:else}
                      <div class="image-placeholder">No Poster</div>
                    {/if}
                  </div>
                </div>
                <button
                  class="secondary"
                  onclick={() => handleSetImage('poster', { type: 'local' })}
                  disabled={isSettingImage}>Choose Local File</button
                >
              </div>
              <div class="image-list" onwheel={horizontalScroll}>
                {#each posters as image (image.file_path)}
                  <button
                    class="image-thumb"
                    onclick={() =>
                      handleSetImage('poster', { type: 'tmdb', path: image.file_path })}
                    disabled={isSettingImage}
                  >
                    <img
                      src="https://image.tmdb.org/t/p/w154{image.file_path}"
                      alt="Poster option"
                      loading="lazy"
                    />
                  </button>
                {/each}
              </div>
            </div>
          </section>

          <section>
            <h4>Logo</h4>
            <div class="artwork-container">
              <div class="current-artwork-wrapper">
                <div class="current-image-container">
                  <div class="current-image logo">
                    {#if item.logoPath}
                      <img
                        src="media-browser-asset://images/{item.logoPath}{item._v
                          ? `?v=${item._v}`
                          : ''}"
                        alt="Current Logo"
                      />
                      <button
                        class="remove-image-btn"
                        title="Remove Logo"
                        onclick={() => handleRemoveImage('logo')}>&times;</button
                      >
                    {:else}
                      <div class="image-placeholder">No Logo</div>
                    {/if}
                  </div>
                </div>
                <button
                  class="secondary"
                  onclick={() => handleSetImage('logo', { type: 'local' })}
                  disabled={isSettingImage}>Choose Local File</button
                >
              </div>
              <div class="image-list" onwheel={horizontalScroll}>
                {#each logos as image (image.file_path)}
                  <button
                    class="image-thumb logo"
                    onclick={() => handleSetImage('logo', { type: 'tmdb', path: image.file_path })}
                    disabled={isSettingImage}
                  >
                    <img
                      src="https://image.tmdb.org/t/p/w154{image.file_path}"
                      alt="Logo option"
                      loading="lazy"
                    />
                  </button>
                {/each}
              </div>
            </div>
          </section>

          <section>
            <h4>Backdrop</h4>
            <div class="artwork-container backdrop">
              <div class="current-artwork-wrapper backdrop">
                <div class="current-image-container">
                  <div class="current-image backdrop">
                    {#if item.backdropPath}
                      <img
                        src="media-browser-asset://images/{item.backdropPath}{item._v
                          ? `?v=${item._v}`
                          : ''}"
                        alt="Current Backdrop"
                      />
                      <button
                        class="remove-image-btn"
                        title="Remove Backdrop"
                        onclick={() => handleRemoveImage('backdrop')}>&times;</button
                      >
                    {:else}
                      <div class="image-placeholder">No Backdrop</div>
                    {/if}
                  </div>
                </div>
                <button
                  class="secondary"
                  onclick={() => handleSetImage('backdrop', { type: 'local' })}
                  disabled={isSettingImage}>Choose Local File</button
                >
              </div>
              <div class="image-list backdrop" onwheel={horizontalScroll}>
                {#each backdrops as image (image.file_path)}
                  <button
                    class="image-thumb backdrop"
                    onclick={() =>
                      handleSetImage('backdrop', { type: 'tmdb', path: image.file_path })}
                    disabled={isSettingImage}
                  >
                    <img
                      src="https://image.tmdb.org/t/p/w300{image.file_path}"
                      alt="Backdrop option"
                      loading="lazy"
                    />
                  </button>
                {/each}
              </div>
            </div>
          </section>
        </div>
      {/if}
    </div>

    <div class="actions">
      <button class="secondary" onclick={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
  /* Basic modal structure */
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
    z-index: 200;
  }
  .modal-content {
    background-color: var(--color-background-soft);
    padding: 0;
    border-radius: 8px;
    width: 90%;
    max-width: 900px;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    position: relative;
    overflow: hidden;
  }
  header {
    padding: 1.5rem 1.5rem 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }
  .tabs {
    display: flex;
  }
  .tabs button {
    padding: 0.8rem 1.2rem;
    cursor: pointer;
    background: none;
    border: none;
    color: var(--ev-c-text-2);
    font-size: 1rem;
    font-weight: 600;
    border-bottom: 3px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button:hover:not(:disabled) {
    color: var(--ev-c-text-1);
  }
  .tabs button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .tabs button.active {
    color: var(--ev-c-text-1);
    border-bottom-color: var(--ev-c-white-soft);
  }

  .tab-content {
    flex-grow: 1;
    overflow-y: auto;
    padding: 1.5rem;
  }

  /* Match Tab */
  .search-form {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .search-form input,
  .search-form select {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }
  .search-form .title-input {
    flex-grow: 1;
  }
  .search-form .year-input {
    flex-grow: 0;
    width: 70px;
  }

  .search-results {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .result-item {
    display: flex;
    gap: 1rem;
    background-color: var(--color-background);
    padding: 1rem;
    border-radius: 6px;
  }
  .result-poster {
    width: 100px;
    aspect-ratio: 2 / 3;
    flex-shrink: 0;
    background-color: var(--color-background-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .result-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .result-info {
    flex-grow: 1;
  }
  .result-info h3 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
  }
  .result-info p {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    max-height: 7em;
    overflow: hidden;
  }
  .result-actions {
    display: flex;
    align-items: center;
  }

  /* Artwork Tab */
  .artwork-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .artwork-controls > div {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .artwork-controls select {
    padding: 0.5rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    color: var(--color-text);
    border-radius: 4px;
    font-family: inherit;
    font-size: 1rem;
  }

  .image-sections {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    min-height: 400px; /* Give it some space */
  }

  .artwork-container {
    display: flex;
    gap: 1rem;
    height: 100%;
  }

  .current-artwork-wrapper {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .current-artwork-wrapper:not(.backdrop) {
    flex-basis: 154px; /* Poster thumb width */
  }
  .current-artwork-wrapper.backdrop {
    flex-basis: 300px; /* Backdrop thumb width */
  }

  .current-image {
    width: 100%;
    background-color: var(--color-background);
    border-radius: 6px;
    overflow: hidden;
  }
  .current-image.backdrop,
  .current-image.logo {
    aspect-ratio: 16/9;
  }
  .current-image:not(.backdrop):not(.logo) {
    aspect-ratio: 2/3;
  }
  .current-image img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .current-image.logo img {
    object-fit: contain;
    background-color: var(--color-background); /* For letterboxing */
    padding: 0.5rem;
  }
  .image-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    color: var(--ev-c-text-3);
    font-style: italic;
  }

  .image-list {
    flex-grow: 1;
    display: flex;
    flex-direction: row;
    gap: 0.75rem;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 10px; /* Space for scrollbar */
    align-items: flex-start;
  }

  .image-thumb {
    background: none;
    border: 2px solid transparent;
    padding: 0;
    cursor: pointer;
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0; /* Prevent items from shrinking in flex container */
  }
  .image-thumb:hover {
    border-color: var(--ev-c-white-soft);
  }
  .image-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .current-image.backdrop img,
  .image-thumb.backdrop img,
  .image-thumb.logo img {
    object-fit: contain;
    background-color: var(--color-background); /* For letterboxing */
  }
  .image-thumb.logo img {
    padding: 0.5rem;
  }

  .current-image-container {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .remove-image-btn {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background-color: rgba(0, 0, 0, 0.6);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.2);
    font-size: 1.2rem;
    line-height: 1;
    padding: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    opacity: 0;
    transition: all 0.2s;
    z-index: 5; /* Above the image */
  }

  .current-image-container:hover .remove-image-btn {
    opacity: 1;
  }

  .remove-image-btn:hover {
    background-color: #e81123;
    border-color: #e81123;
    transform: scale(1.1);
  }

  /* Common */
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    padding: 1.5rem;
    border-top: 1px solid var(--color-background-mute);
    flex-shrink: 0;
  }
  button {
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 5px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.9rem;
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
  }
  button:hover:not(:disabled) {
    background-color: var(--ev-c-gray-1);
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.secondary {
    background-color: var(--ev-button-alt-bg);
    border: 1px solid var(--ev-c-gray-2);
  }
  button.secondary:hover:not(:disabled) {
    background-color: var(--ev-c-black-mute);
  }
  .empty-text {
    color: var(--ev-c-text-2);
    padding: 2rem;
    text-align: center;
  }
</style>
