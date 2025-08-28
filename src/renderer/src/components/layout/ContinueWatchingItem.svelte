<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { tabNavigationIntent } from '../../lib/view-state-store'

  type ContinueWatchingItem = {
    show: MediaFolder
    nextEpisode: MediaFile
  }

  let {
    item,
    layout = 'vertical'
  }: {
    item: ContinueWatchingItem
    layout?: 'vertical' | 'horizontal'
  } = $props()

  const dispatch = createEventDispatcher<{
    dismiss: { showId: string }
    itemClick: { item: LibraryItem }
  }>()

  function handleShowDetailsClick() {
    // Before dispatching the navigation, set the intent to open the correct tab.
    if (item.nextEpisode.seasonNumber != null) {
      tabNavigationIntent.set({
        targetShowId: item.show.id,
        targetSeasonNumber: item.nextEpisode.seasonNumber
      })
    }
    dispatch('itemClick', { item: item.show })
  }

  function handleItemKeydown(event: KeyboardEvent, target: 'play' | 'show') {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (target === 'play') {
        dispatch('itemClick', { item: item.nextEpisode })
      } else {
        handleShowDetailsClick()
      }
    }
  }

  function handleDismiss(event: MouseEvent, showId: string) {
    event.stopPropagation()
    dispatch('dismiss', { showId })
  }

  const posterToShow = $derived(item.nextEpisode.posterPath ?? item.show.posterPath)
</script>

<div
  class="cw-item"
  class:horizontal={layout === 'horizontal'}
  class:vertical={layout === 'vertical'}
  role={layout === 'horizontal' ? 'button' : undefined}
  tabindex={layout === 'horizontal' ? 0 : undefined}
  aria-label={layout === 'horizontal' ? 'Play next episode' : undefined}
  onclick={layout === 'horizontal' ? () => dispatch('itemClick', { item: item.nextEpisode }) : null}
  onkeydown={layout === 'horizontal' ? (e) => handleItemKeydown(e, item.nextEpisode) : null}
>
  <div
    class="cw-poster"
    role={layout === 'vertical' ? 'button' : undefined}
    tabindex={layout === 'vertical' ? 0 : undefined}
    aria-label="Play next episode"
    onclick={layout === 'vertical' ? () => dispatch('itemClick', { item: item.nextEpisode }) : null}
    onkeydown={layout === 'vertical' ? (e) => handleItemKeydown(e, 'play') : null}
  >
    {#if posterToShow}
      <img
        src="media-browser-asset://images/{posterToShow}{item.nextEpisode._v
          ? `?v=${item.nextEpisode._v}`
          : ''}"
        alt={item.nextEpisode.title ?? item.show.title}
        loading="lazy"
      />
    {:else}
      <div class="no-poster-icon">🎬</div>
    {/if}
    <div class="cw-poster-overlay">
      <div class="play-icon">▶</div>
    </div>
  </div>
  <div
    class="cw-info"
    role={layout === 'vertical' ? 'button' : undefined}
    tabindex={layout === 'vertical' ? 0 : undefined}
    aria-label={layout === 'vertical' ? 'Go to show details' : undefined}
    onclick={layout === 'vertical' ? handleShowDetailsClick : null}
    onkeydown={layout === 'vertical' ? (e) => handleItemKeydown(e, 'show') : null}
  >
    {#if layout !== 'horizontal'}
      <div class="cw-show-title" title={item.show.title ?? item.show.name}>
        {item.show.title ?? item.show.name}
      </div>
    {/if}
    <div
      class="cw-episode-title"
      class:large={layout === 'horizontal'}
      title={item.nextEpisode.title ?? item.nextEpisode.name}
    >
      S{String(item.nextEpisode.seasonNumber).padStart(2, '0')}E{String(
        item.nextEpisode.episodeNumber
      ).padStart(2, '0')}
      - {item.nextEpisode.title ?? item.nextEpisode.name}
    </div>
    {#if layout === 'horizontal' && item.nextEpisode.overview}
      <p class="cw-overview">{item.nextEpisode.overview}</p>
    {/if}
  </div>
  {#if layout === 'vertical' && item.nextEpisode.overview}
    <div class="cw-overview-popup">
      <p class="cw-overview">{item.nextEpisode.overview}</p>
    </div>
  {/if}
  <button class="dismiss-button" title="Dismiss" onclick={(e) => handleDismiss(e, item.show.id)}
    >&times;</button
  >
</div>

<style>
  .cw-item {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 320px;
    flex-shrink: 0;
    background: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    text-align: left;
    color: inherit;
    font: inherit;
    /* cursor: pointer; removed */
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease;
  }

  .cw-item:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
    border-color: var(--color-background-mute);
    background: var(--color-background-soft);
    z-index: 2; /* Ensure hovered item's popup is on top of adjacent items */
  }

  /* Cursors are now conditional based on which element is interactive */
  .cw-item[role='button'],
  .cw-poster[role='button'],
  .cw-info[role='button'] {
    cursor: pointer;
  }

  .cw-poster:focus-visible,
  .cw-info:focus-visible {
    outline: 2px solid var(--ev-c-white-soft);
    outline-offset: 2px;
    border-radius: 6px; /* A consistent focus ring */
  }

  .cw-info {
    /* Give info section rounded corners to contain the hover effect */
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
    transition: background-color 0.2s ease;
  }
  .cw-item.horizontal .cw-info {
    border-radius: 6px;
  }
  .cw-item:not(.horizontal) .cw-info:hover {
    background-color: var(--ev-c-gray-3);
  }

  .cw-item.horizontal {
    flex-direction: row;
    width: 100%;
    gap: 1.5rem;
    padding: 1rem;
    align-items: center;
  }

  .cw-poster {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 8px 8px 0 0;
    overflow: hidden;
    position: relative;
    background-color: var(--color-background);
  }
  .cw-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s ease;
  }
  .cw-item:hover .cw-poster img {
    transform: scale(1.05);
  }
  .cw-item.horizontal .cw-poster {
    width: 200px;
    flex-shrink: 0;
    border-radius: 6px; /* Rounded corners on all sides */
  }
  .cw-poster-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7) 10%, transparent 60%);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  .cw-item.vertical .cw-poster:hover .cw-poster-overlay,
  .cw-item.horizontal:hover .cw-poster-overlay {
    opacity: 1;
  }
  .cw-item.horizontal:hover {
    background-color: var(--color-background-mute);
  }
  .cw-item.horizontal {
    transition:
      transform 0.2s ease,
      background-color 0.2s ease;
  }
.play-icon {
    font-size: 3rem;
    color: rgba(255, 255, 255, 0.8);
    text-shadow: 0 0 15px black;
  }
  .no-poster-icon {
    font-size: 3rem;
    color: var(--ev-c-text-3);
  }

  .cw-info {
    padding: 0.75rem 1rem;
    overflow: hidden;
    flex-grow: 1;
  }
  .cw-item.horizontal .cw-info {
    padding: 0;
  }
  .cw-show-title {
    font-weight: 600;
    font-size: 1rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cw-episode-title {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cw-episode-title.large {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--ev-c-text-1);
  }

  .cw-overview-popup {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    background: var(--color-background-soft);
    padding: 1rem;
    border-radius: 8px;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
    border: 1px solid var(--ev-c-black-mute);
    opacity: 0;
    transform: translateY(-10px) scale(0.98);
    pointer-events: none;
    transition:
      opacity 0.25s ease-out,
      transform 0.25s ease-out;
  }

  .cw-item:hover .cw-overview-popup {
    opacity: 1;
    transform: translateY(0.75rem) scale(1);
  }

  .cw-overview {
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    line-height: 1.5;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cw-item.horizontal .cw-overview {
    -webkit-line-clamp: 2;
    margin-top: 0.5rem;
  }

  .dismiss-button {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background-color: rgba(0, 0, 0, 0.6);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.2);
    font-size: 1.5rem;
    line-height: 1;
    padding: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    opacity: 0.6;
    transition: all 0.2s;
    z-index: 5;
  }
  .cw-item:hover .dismiss-button {
    opacity: 1;
  }
  .dismiss-button:hover {
    background-color: #e81123;
    border-color: #e81123;
    transform: scale(1.1);
  }

  /* --- Full Backdrop Mode Styles --- */
  :global(.full-backdrop-mode) .cw-item.horizontal {
    background-color: rgba(30, 30, 33, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-color: rgba(255, 255, 255, 0.1);
  }
  :global(.full-backdrop-mode) .cw-item.horizontal:hover {
    background-color: rgba(50, 50, 55, 0.8);
    border-color: rgba(255, 255, 255, 0.15);
  }
</style>
