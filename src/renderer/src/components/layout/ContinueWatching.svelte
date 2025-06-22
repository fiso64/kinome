<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  type ContinueWatchingItem = {
    show: MediaFolder
    nextEpisode: MediaFile
  }

  let {
    items
  }: {
    items: ContinueWatchingItem[]
  } = $props()

  const dispatch = createEventDispatcher<{
    dismiss: { showId: string }
    itemClick: { item: LibraryItem }
  }>()

  function handleItemKeydown(event: KeyboardEvent, item: LibraryItem) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      dispatch('itemClick', { item })
    }
  }

  function horizontalScroll(event: WheelEvent) {
    if (event.deltaY === 0) return
    event.preventDefault()
    const element = event.currentTarget as HTMLElement
    element.scrollLeft += event.deltaY
  }

  function handleDismiss(event: MouseEvent, showId: string) {
    event.stopPropagation()
    dispatch('dismiss', { showId })
  }
</script>

<div class="continue-watching-list" onwheel={horizontalScroll}>
  {#each items as { show, nextEpisode } (show.id)}
    <div
      class="cw-item"
      role="button"
      tabindex="0"
      onclick={() => dispatch('itemClick', { item: nextEpisode })}
      onkeydown={(e) => handleItemKeydown(e, nextEpisode)}
    >
      <div class="cw-poster">
        <img
          src="media-browser-asset://images/{nextEpisode.posterPath ?? show.posterPath}{nextEpisode._v
            ? `?v=${nextEpisode._v}`
            : ''}"
          alt={nextEpisode.title ?? show.title}
          loading="lazy"
        />
        <div class="cw-poster-overlay">
          <div class="play-icon">▶</div>
        </div>
      </div>
      <div class="cw-info">
        <div class="cw-show-title" title={show.title ?? show.name}>{show.title ?? show.name}</div>
        <div class="cw-episode-title" title={nextEpisode.title ?? nextEpisode.name}>
          S{String(nextEpisode.seasonNumber).padStart(2, '0')}E{String(
            nextEpisode.episodeNumber
          ).padStart(2, '0')}
          - {nextEpisode.title ?? nextEpisode.name}
        </div>
        <p class="cw-overview">{nextEpisode.overview}</p>
      </div>
      <button
        class="dismiss-button"
        title="Dismiss"
        onclick={(e) => handleDismiss(e, show.id)}>&times;</button
      >
    </div>
  {/each}
</div>

<style>
  .continue-watching-list {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    gap: 1.5rem;
    padding: 0.5rem 1.5rem 1.5rem 1.5rem;
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .continue-watching-list::-webkit-scrollbar {
    display: none;
  }

  .cw-item {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 320px;
    flex-shrink: 0;
    background: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    text-align: left;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease;
  }
  .cw-item:focus-visible {
    outline: 2px solid var(--ev-c-white-soft);
    outline-offset: 2px;
  }
  .cw-item:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
    border-color: var(--color-background-mute);
    background: var(--color-background-soft);
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
  .cw-item:hover .cw-poster-overlay {
    opacity: 1;
  }
  .play-icon {
    font-size: 3rem;
    color: rgba(255, 255, 255, 0.8);
    text-shadow: 0 0 15px black;
  }

  .cw-info {
    padding: 0 1rem 1rem;
    overflow: hidden;
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
    margin-bottom: 0.5rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cw-overview {
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    margin: 0;
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
</style>