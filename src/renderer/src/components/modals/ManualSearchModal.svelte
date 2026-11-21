<script lang="ts">
  import { onMount } from 'svelte'
  import type { LibraryItem, TmdbSearchResult, TmdbImage } from '@shared/types'
  import { itemCapabilities } from '@shared/item-capabilities'
  import { parseTitle } from '@shared/title-parser'
  import { getAssetUrl } from '@lib/api'
  import ModalWindow from './_base/ModalWindow.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import { notificationStore } from '@lib/notification-store.svelte'

  let {
    item,
    onClose,
    initialTab = 'match'
  }: {
    item: LibraryItem
    onClose: () => void
    initialTab?: 'match' | 'artwork'
  } = $props()

  const artworkTypes = [
    { type: 'poster', label: 'Poster', pathField: 'posterPath', imageSize: 'w154' },
    { type: 'logo', label: 'Logo', pathField: 'logoPath', imageSize: 'w154' },
    { type: 'backdrop', label: 'Backdrop', pathField: 'backdropPath', imageSize: 'w300' }
  ] as const
  type ArtworkType = (typeof artworkTypes)[number]['type']

  const caps = itemCapabilities(item)
  let activeTab: 'match' | 'artwork' = $state(caps.canManualSearch ? initialTab : 'artwork')

  // --- Granular Loading States ---
  let isSearching = $state(false)
  let isFetchingArtwork = $state(false)
  let isSettingImage = $state(false)
  let applyingResultId = $state<number | null>(null)

  // Match tab state
  const guessedTitle = parseTitle(item.name, item.type)
  let searchQuery = $state(guessedTitle.title)
  let searchTmdbId = $state('')
  let searchBy = $state<'title' | 'id'>('title')
  let searched = $state(false)
  let searchYear = $state(guessedTitle.year?.toString() ?? '')

  function initialSearchType(): 'movie' | 'tv' | 'season' {
    if (item.mediaType === 'season') return 'season'
    if (item.mediaType === 'tv' || item.mediaType === 'episode') return 'tv'
    if (item.mediaType === 'movie') return 'movie'
    return item.type === 'folder' ? 'tv' : 'movie'
  }

  let searchType = $state(initialSearchType())
  let resultType = $state<'movie' | 'tv' | 'season'>('movie')
  let searchResults = $state<TmdbSearchResult[]>([])
  let searchInput = $state<HTMLInputElement | undefined>(undefined)

  // Artwork tab state
  let imageLang = $state('en')
  let artwork = $state<Record<ArtworkType, TmdbImage[]>>({ poster: [], logo: [], backdrop: [] })

  // --- Hydration & Refresh Logic ---
  // The 'item' prop is static. We use localOverrides to store:
  // 1. Initial hydration of missing fields (logoPath, backdropPath)
  // 2. Updates after we modify the item (new _v, new paths)
  let localOverrides = $state<Partial<LibraryItem>>({})

  $effect(() => {
    // Initial Hydration
    const id = item.id
    // We only need to hydrate if we haven't already.
    // But since 'item' prop doesn't change, this effect runs once on mount.
    window.api
      .getItem(id, { fields: ['logoPath', 'backdropPath', 'posterPath', 'mediaType', '_v'] })
      .then((fullItem) => {
        const propVersion = item._v || 0
        const fetchedVersion = fullItem._v || 0

        if (fetchedVersion < propVersion) {
          // If fetch is stale compared to prop, only backfill missing fields
          localOverrides = {
            ...localOverrides,
            logoPath: localOverrides.logoPath ?? fullItem.logoPath,
            backdropPath: localOverrides.backdropPath ?? fullItem.backdropPath
          } as Partial<LibraryItem>
        } else {
          localOverrides = {
            ...localOverrides,
            logoPath: fullItem.logoPath,
            backdropPath: fullItem.backdropPath,
            posterPath: fullItem.posterPath,
            mediaType: fullItem.mediaType,
            _v: fullItem._v
          } as Partial<LibraryItem>
        }
      })
  })

  // Merge prop item with local overrides. Overrides take precedence.
  const localItem = $derived({
    ...item,
    ...localOverrides
  })

  async function performSearch() {
    if (!(searchBy === 'title' ? searchQuery.trim() : searchTmdbId.trim()) || isSearching) return
    isSearching = true
    const type = searchType
    try {
      searchResults = await window.api.manualSearch(
        searchBy === 'title' ? searchQuery : '', type, searchBy === 'title' ? searchYear : '', searchBy === 'id' ? searchTmdbId : ''
      )
      resultType = type
      searched = true
    } catch (err: any) {
      notificationStore.add(err.message || 'Search failed.', 'error')
    } finally {
      isSearching = false
    }
  }

  async function applyResult(result: TmdbSearchResult) {
    applyingResultId = result.id
    try {
      // De-proxy the reactive Svelte object before sending it over IPC
      const plainResult = JSON.parse(JSON.stringify(result))
      await window.api.applyManualMatch(localItem.id, plainResult, resultType)
      // The modal will be closed automatically when the parent receives the item update.
      onClose()
    } catch (err: any) {
      notificationStore.add(err.message || 'Failed to apply match.', 'error')
    } finally {
      applyingResultId = null
    }
  }

  function getYear(result: TmdbSearchResult): string {
    const date = result.release_date || result.first_air_date
    if (!date) return 'N/A'
    return date.split('-')[0]
  }

  async function fetchImages() {
    if (!localItem.tmdbId || !localItem.mediaType || isFetchingArtwork) return
    isFetchingArtwork = true
    // Clear old results before fetching new ones
    artwork = { poster: [], logo: [], backdrop: [] }
    try {
      const tmdbMediaType = (localItem.mediaType === 'movie' ? 'movie' : 'tv') as 'movie' | 'tv'
      const images = await window.api.getTmdbImages(
        localItem.tmdbId as number,
        tmdbMediaType,
        imageLang
      )
      artwork = { poster: images.posters, logo: images.logos, backdrop: images.backdrops }
    } catch (err) {
      notificationStore.add(err instanceof Error ? err.message : 'Could not load artwork.', 'error')
    } finally {
      isFetchingArtwork = false
    }
  }

  async function handleRemoveImage(imageType: ArtworkType) {
    isSettingImage = true
    try {
      await window.api.removeImage(localItem.id, imageType)
      await refreshLocalItem()
    } catch (err) {
      notificationStore.add(err instanceof Error ? err.message : 'Could not remove artwork.', 'error')
    } finally {
      isSettingImage = false
    }
  }

  async function handleSetImage(
    imageType: ArtworkType,
    source: { type: 'tmdb'; path: string } | { type: 'local' }
  ) {
    isSettingImage = true
    try {
      if (source.type === 'local') {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = async (e: any) => {
          const file = e.target.files?.[0]
          if (file) {
            isSettingImage = true
            try {
              await window.api.uploadImage(localItem.id, imageType, file)
              await refreshLocalItem()
            } catch (err) {
              notificationStore.add(err instanceof Error ? err.message : 'Could not upload artwork.', 'error')
            } finally {
              isSettingImage = false
            }
          }
        }
        input.click()
      } else {
        await window.api.setImage(localItem.id, imageType, JSON.parse(JSON.stringify(source)))
        await refreshLocalItem()
      }
    } catch (err) {
      notificationStore.add(err instanceof Error ? err.message : 'Could not apply artwork.', 'error')
    } finally {
      isSettingImage = false
    }
  }

  // Reloads the item data to reflect changes (new _v, new paths)
  async function refreshLocalItem() {
    try {
      // Fetch all potential artwork fields
      const fresh = await window.api.getItem(localItem.id, {
        fields: ['logoPath', 'backdropPath', 'posterPath', '_v']
      })
      localOverrides = {
        ...localOverrides,
        logoPath: fresh.logoPath,
        backdropPath: fresh.backdropPath,
        posterPath: fresh.posterPath,
        _v: fresh._v
      }
    } catch (err) {
      console.error('Failed to refresh item after update:', err)
    }
  }

  function horizontalScroll(event: WheelEvent) {
    if (event.deltaY === 0 || !event.ctrlKey) return // Only scroll horizontally with Ctrl + wheel
    event.preventDefault()
    const element = event.currentTarget as HTMLElement
    element.scrollLeft += event.deltaY
  }

  onMount(() => {
    if (!caps.canManualSearch || item.mediaType === 'movie' || item.mediaType === 'tv' || item.mediaType === 'episode') return

    let active = true
    void window.api.getParent(item.id).then((parent) => {
      if (!active) return
      if (parent?.mediaType === 'tv') searchType = 'season'
      if (searchType === 'season' && parent?.tmdbId) {
        searchTmdbId = parent.tmdbId.toString()
        searchBy = 'id'
      }
    }).catch(() => {})
    return () => { active = false }
  })

  $effect(() => {
    searchInput?.focus()
  })
</script>

<ModalWindow title="Match metadata" {onClose} cancelText="Close" maxWidth="900px">
  {#snippet header()}
    <div class="selection-bar" role="group" aria-label="Metadata sections">
      {#if caps.canManualSearch}
        <button type="button" aria-pressed={activeTab === 'match'} onclick={() => (activeTab = 'match')}
          >Match</button
        >
      {/if}
      <button type="button" aria-pressed={activeTab === 'artwork'} onclick={() => (activeTab = 'artwork')}
        >Artwork</button
      >
    </div>
  {/snippet}

  <div class="modal-body-content">
    {#if activeTab === 'match'}
      <form class="search-form raised-surface"
        onsubmit={(event) => { event.preventDefault(); void performSearch() }}>
        <div class="selection-bar" role="group" aria-label="Match by">
          <button type="button" aria-pressed={searchBy === 'title'} onclick={() => (searchBy = 'title')}>By title</button>
          <button type="button" aria-pressed={searchBy === 'id'} onclick={() => (searchBy = 'id')}>By TMDB ID</button>
        </div>
        <div class="search-fields">
          {#if searchBy === 'title'}
            <div class="form-field search-name">
              <label for="match-title">Title</label>
              <input id="match-title" type="text" bind:this={searchInput} bind:value={searchQuery} />
            </div>
            <div class="form-field search-year">
              <label for="match-year">Year</label>
              <input id="match-year" type="text" inputmode="numeric" bind:value={searchYear} maxlength="4" />
            </div>
          {:else}
            <div class="form-field search-name">
              <label for="match-id">TMDB ID</label>
              <input id="match-id" type="text" inputmode="numeric" bind:this={searchInput} bind:value={searchTmdbId} />
            </div>
          {/if}
          <div class="form-field">
            <label for="match-type">Type</label>
            <select id="match-type" bind:value={searchType}>
              <option value="movie">Movie</option>
              <option value="tv">TV show</option>
              <option value="season">Season</option>
            </select>
          </div>
          <button class="primary" type="submit"
            disabled={isSearching || !(searchBy === 'title' ? searchQuery.trim() : searchTmdbId.trim())}>
            <Icon name="search" size={17} /> {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>
      </form>
      <div class="search-results" aria-busy={isSearching}>
        {#each searchResults as result (result.id)}
          <div class="result-item raised-surface">
            <div class="result-poster">
              {#if result.poster_path}
                <img src="https://image.tmdb.org/t/p/w154{result.poster_path}" alt="" loading="lazy" />
              {/if}
            </div>
            <div class="result-info">
              <h3>
                {#if resultType === 'season' && typeof result.season_number !== 'undefined'}
                  {result.season_number}. {result.name ?? result.title} ({getYear(result)})
                  {#if typeof result.episode_count !== 'undefined'}
                    <span class="episode-count">({result.episode_count} episodes)</span>
                  {/if}
                {:else}
                  {result.title ?? result.name} ({getYear(result)})
                {/if}
              </h3>
              <p>{result.overview}</p>
            </div>
            <div class="result-actions">
              <button onclick={() => applyResult(result)} disabled={applyingResultId !== null}>
                {#if applyingResultId === result.id}Applying...{:else}Select{/if}
              </button>
            </div>
          </div>
        {:else}
          {#if searched && !isSearching}
            <p class="form-hint">No matches found.</p>
          {/if}
        {/each}
      </div>
    {:else if activeTab === 'artwork'}
      <div class="artwork-controls">
        <div>
          <label class="field-label" for="lang-select">Image language</label>
          <select id="lang-select" bind:value={imageLang} disabled={isFetchingArtwork}>
            <option value="en">English</option>
            <option value="ja">Japanese</option>
            <option value="de">German</option>
            <option value="fr">French</option>
            <option value="es">Spanish</option>
            <option value="none">All (No Language)</option>
          </select>
        </div>
        <button
          class="primary"
          onclick={fetchImages}
          disabled={isFetchingArtwork || !localItem.tmdbId}
        >
          {#if isFetchingArtwork}Finding...{:else}Find Artwork{/if}
        </button>
      </div>

      <div class="image-sections" aria-busy={isFetchingArtwork || isSettingImage}>
        {#each artworkTypes as entry (entry.type)}
          {@const current = localItem[entry.pathField]}
          <section class="artwork-section raised-surface" class:poster={entry.type === 'poster'}>
            <div class="artwork-heading">
              <h3>{entry.label}</h3>
              <button class="secondary" type="button" disabled={isSettingImage}
                onclick={() => handleSetImage(entry.type, { type: 'local' })}>Upload</button>
            </div>
            <div class="artwork-strip">
              <div class="current-image">
                {#if current}
                  <img src={getAssetUrl(current + (localItem._v ? `?v=${localItem._v}` : ''))}
                    alt={`Current ${entry.label.toLowerCase()}`} />
                  <button class="icon-button remove-image" title={`Remove ${entry.label.toLowerCase()}`}
                    disabled={isSettingImage} onclick={() => handleRemoveImage(entry.type)}>
                    <Icon name="close" size={15} />
                  </button>
                {:else}
                  <span class="form-hint">No {entry.label.toLowerCase()}</span>
                {/if}
              </div>
              {#if artwork[entry.type].length}
                <div class="image-list" aria-label={`${entry.label} options`} role="group"
                  onwheel={horizontalScroll}>
                  {#each artwork[entry.type] as image, i (image.file_path)}
                    <button type="button" class="image-thumb" disabled={isSettingImage}
                      aria-label={`Use ${entry.label.toLowerCase()} ${i + 1}`}
                      onclick={() => handleSetImage(entry.type, { type: 'tmdb', path: image.file_path })}>
                      <img src={`https://image.tmdb.org/t/p/${entry.imageSize}${image.file_path}`} alt="" loading="lazy" />
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</ModalWindow>

<style>
  .modal-body-content { padding: clamp(.8rem, 2.8vw, 1.3rem); }
  .search-form { display: grid; gap: .75rem; padding: .75rem; margin-bottom: .85rem; }
  .search-form .selection-bar { justify-self: start; }
  .search-fields { display: flex; align-items: end; flex-wrap: wrap; gap: .55rem; }
  .search-name { flex: 1 1 12rem; }
  .search-year { flex: 0 1 5.5rem; min-width: 4.3rem; }
  .search-fields > button { display: inline-flex; align-items: center; gap: .35rem; }

  .search-results { display: grid; gap: .55rem; }
  .result-item { display: flex; align-items: flex-start; gap: .75rem; padding: .65rem; }
  .result-poster {
    flex: 0 0 clamp(48px, 9vw, 84px);
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-field);
    background: var(--color-inset);
    overflow: hidden;
  }
  .result-poster img { width: 100%; height: 100%; object-fit: cover; }
  .result-info { flex: 1; min-width: 0; }
  .result-info h3 { font-size: 1rem; font-weight: 650; }
  .episode-count, .result-info p { color: var(--color-text-soft); font-size: .84rem; }
  .result-info p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }

  .artwork-controls, .artwork-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: .55rem; }
  .artwork-controls { margin-bottom: .9rem; }
  .artwork-controls > div { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .image-sections { display: grid; gap: .65rem; }
  .artwork-section { display: grid; gap: .55rem; min-width: 0; padding: .65rem; --artwork-width: clamp(108px, 21vw, 210px); --artwork-aspect: 16 / 9; }
  .artwork-section.poster { --artwork-width: clamp(68px, 14vw, 110px); --artwork-aspect: 2 / 3; }
  .artwork-heading h3 { font-size: .95rem; font-weight: 650; }
  .artwork-strip { display: flex; align-items: flex-start; gap: .6rem; min-width: 0; }
  .current-image, .image-thumb {
    position: relative;
    display: grid;
    place-items: center;
    flex: 0 0 var(--artwork-width);
    width: var(--artwork-width);
    aspect-ratio: var(--artwork-aspect);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-field);
    background: var(--color-inset);
    overflow: hidden;
    padding: 0;
  }
  .current-image img, .image-thumb img { width: 100%; height: 100%; display: block; object-fit: contain; }
  .image-thumb:hover { border-color: var(--accent-border); }
  .image-list { display: flex; min-width: 0; gap: .45rem; overflow-x: auto; padding-bottom: .25rem; }
  .remove-image { position: absolute; top: .3rem; right: .3rem; width: 26px; height: 26px; background: var(--color-inset); }
  .remove-image:hover { color: var(--color-danger-soft); }

  @media (max-width: 520px) {
    .result-item { display: grid; grid-template-columns: 55px minmax(0, 1fr); }
    .result-actions { grid-column: 2; }
    .result-info p { -webkit-line-clamp: 2; line-clamp: 2; }
  }
</style>
