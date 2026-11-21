<script lang="ts">
  import type { MediaFolder, MediaFile, LibraryItem } from '@shared/types'
  import { createEventDispatcher } from 'svelte'
  import { getAssetUrl } from '@lib/api'
  import Icon from '@components/ui/Icon.svelte'
  type ContinueWatchingItem = {
    show: MediaFolder
    nextEpisode: MediaFile
  }

  let {
    item,
    layout = 'vertical',
    glass = false,
    embedded = false
  }: {
    item: ContinueWatchingItem
    layout?: 'vertical' | 'horizontal'
    glass?: boolean
    embedded?: boolean
  } = $props()

  const dispatch = createEventDispatcher<{
    dismiss: { showId: string }
    itemClick: { item: LibraryItem }
    showContextMenu: { item: LibraryItem; event: MouseEvent }
  }>()

  function playNextEpisode() {
    dispatch('itemClick', { item: item.nextEpisode })
  }

  function handleDismiss(event: MouseEvent, showId: string) {
    event.stopPropagation()
    dispatch('dismiss', { showId })
  }

  function handleContextMenu(event: MouseEvent, target: LibraryItem | 'show') {
    // We do NOT preventDefault here. We let the store handle it so that it can
    // distinguish between a first click (app menu) and second click (native menu).
    event.stopPropagation()
    const itemToMenu = target === 'show' ? item.show : (target as LibraryItem)
    dispatch('showContextMenu', { item: itemToMenu, event })
  }

  const posterToShow = $derived(item.nextEpisode.posterPath ?? item.show.posterPath)
</script>

{#snippet thumbnail()}
  {#if posterToShow}
    <img
      src={getAssetUrl(posterToShow + (item.nextEpisode._v ? `?v=${item.nextEpisode._v}` : ''))}
      alt="" loading="lazy" decoding="async"
    />
  {:else}
    <span class="no-poster-icon"><Icon name="film" size={36} /></span>
  {/if}
  <span class="cw-poster-overlay">
    <span class="play-icon"><Icon name="play" size={21} /></span>
  </span>
{/snippet}

{#snippet episodeTitle()}
  <span class="cw-episode-title" class:large={layout === 'horizontal'}
    title={item.nextEpisode.title ?? item.nextEpisode.name}>
    S{String(item.nextEpisode.seasonNumber).padStart(2, '0')}E{String(item.nextEpisode.episodeNumber).padStart(2, '0')}
    - {item.nextEpisode.title ?? item.nextEpisode.name}
  </span>
{/snippet}

<div class="cw-item" class:interactive-card={!embedded} class:embedded
  class:horizontal={layout === 'horizontal'} class:vertical={layout === 'vertical'} class:glass
  oncontextmenu={(event) => handleContextMenu(event, item.nextEpisode)}>
  {#if layout === 'horizontal'}
    <button type="button" class="cw-result thumbnail-action" aria-label="Play next episode" onclick={playNextEpisode}>
      <span class="cw-poster">{@render thumbnail()}</span>
      <span class="cw-info">
        {@render episodeTitle()}
        {#if item.nextEpisode.overview}<span class="cw-overview">{item.nextEpisode.overview}</span>{/if}
      </span>
    </button>
  {:else}
    <button type="button" class="cw-poster thumbnail-action" aria-label="Play next episode" onclick={playNextEpisode}>
      {@render thumbnail()}
    </button>
    <button type="button" class="cw-info" aria-label="Go to show details"
      onclick={() => dispatch('itemClick', { item: item.show })}>
      <span class="cw-show-title" title={item.show.title ?? item.show.name}>{item.show.title ?? item.show.name}</span>
      {@render episodeTitle()}
      <span class="show-arrow"><Icon name="right" size={17} /></span>
    </button>
  {/if}
  <button class="dismiss-button" type="button" title="Dismiss" aria-label="Dismiss"
    onclick={(event) => handleDismiss(event, item.show.id)}><Icon name="close" size={15} /></button>
</div>

<style>
  .cw-item {
    position: relative;
    display: flex;
    flex-direction: column;
    width: clamp(170px, 28vw, 279px);
    flex: none;
    background: var(--surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    color: var(--color-text);
    box-shadow: var(--edge-light), 0 8px 20px #080b1055;
    text-align: start;
    transition: border-color .18s ease, transform .18s ease;
  }
  .cw-item.vertical { overflow: clip; }
  .cw-item.glass { background: var(--surface-glass); }
  .cw-item:is(:hover, :focus-within) {
    border-color: #75889d8c;
  }
  .cw-item.horizontal { width: 100%; }
  .cw-item.embedded { position: static; background: transparent; border-color: transparent; box-shadow: none; }
  .cw-item.embedded .dismiss-button { inset-block-start: .65rem; inset-inline-end: .75rem; }
  .cw-result, button.cw-poster, button.cw-info {
    background: transparent;
    border: 0;
    box-shadow: none;
    color: inherit;
    text-align: left;
    padding: 0;
  }
  .cw-result { display: flex; align-items: center; gap: clamp(.65rem, 2vw, 1.2rem); width: 100%; }
  .cw-item:not(.embedded) .cw-result { padding: .7rem; }
  .cw-result:is(:hover, :focus-visible) .cw-episode-title { color: var(--color-primary-soft); }
  .cw-poster {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: calc(var(--radius-panel) - 1px) calc(var(--radius-panel) - 1px) 0 0;
    overflow: hidden;
    position: relative;
    background: var(--color-inset);
  }
  .cw-item.horizontal .cw-poster { width: clamp(5rem, 22vw, 12.5rem); flex: none; border-radius: var(--radius-field); }
  .cw-poster img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .cw-poster-overlay, .no-poster-icon { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-text-dim); }
  .cw-poster-overlay {
    background: radial-gradient(ellipse, #080c1699, #080c1600 68%);
    opacity: 0;
    transition: opacity .18s;
  }
  :is(button.cw-poster, .cw-result):is(:hover,:focus-visible) .cw-poster-overlay { opacity: 1; }
  .play-icon {
    display: grid;
    place-items: center;
    width: 2.45rem;
    aspect-ratio: 1;
    border-radius: 50%;
    background: #151e2bd9;
    color: var(--color-primary-soft);
    border: 1px solid #ffffff4d;
    box-shadow: var(--edge-light);
  }
  .cw-info { display: block; min-width: 0; flex: 1; overflow: hidden; }
  .vertical .cw-info {
    position: relative;
    padding: .7rem 1.9rem .72rem .8rem;
    border-radius: 0 0 calc(var(--radius-panel) - 1px) calc(var(--radius-panel) - 1px);
    transition: background-color .18s ease, color .18s ease;
  }
  .vertical .cw-info:is(:hover, :focus-visible) { background: #ffffff0a; color: var(--color-primary-soft); }
  .vertical > :is(.cw-poster, .cw-info):focus-visible { outline-offset: -2px; }
  .show-arrow { position: absolute; top: 50%; right: .55rem; display: flex; transform: translateY(-50%); color: var(--color-text-dim); }
  .vertical .cw-info:is(:hover, :focus-visible) .show-arrow { color: var(--color-primary-soft); }
  .horizontal .cw-info { padding: 0 1.65rem 0 0; }
  .cw-show-title, .cw-episode-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cw-show-title { font-weight: 670; font-size: .93rem; }
  .cw-episode-title { color: var(--color-text-soft); font-size: .77rem; }
  .cw-episode-title.large { font-weight: 620; font-size: .94rem; color: var(--color-text); }
  .cw-overview { margin-top: .33rem; color: var(--color-text-soft); font-size: .79rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .dismiss-button {
    position: absolute;
    top: .44rem;
    inset-inline-end: .44rem;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid #ffffff38;
    border-radius: 8px;
    background: #101722dc;
    color: #fff;
  }
  .dismiss-button:hover { color: var(--color-danger-soft); border-color: var(--color-danger-soft); }
</style>
