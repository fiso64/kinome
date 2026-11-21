<script lang="ts">
  import PosterCard from './PosterCard.svelte'
  import type { LibraryItem, MediaFolder, SearchIndexEntry } from '@shared/types'

  import { shouldBeGreyedOut } from '@lib/view-helpers'
  import { getAssetUrl } from '@lib/api'
  type DisplayableItem = LibraryItem | SearchIndexEntry

  let {
    items,
    onItemClick,
    onShowContextMenu,
    grayOutWatched,
    parentItem,
    gridPosterSize
  }: {
    items: DisplayableItem[]
    onItemClick: (item: DisplayableItem) => void
    onShowContextMenu: (
      item: DisplayableItem,
      event: MouseEvent,
      options?: { layout?: string; parentItem?: LibraryItem }
    ) => void
    grayOutWatched: boolean
    parentItem?: MediaFolder
    gridPosterSize?: number | null
  } = $props()
</script>

<div
  class="media-grid"
  style={gridPosterSize ? `--local-grid-poster-size: ${gridPosterSize}px` : ''}
>
  {#if items.length > 0}
    {#each items as item (item.id)}
      {@const baseTitle = item.title ?? ('name' in item ? (item as LibraryItem).name : '')}
      {@const displayTitle =
        'episodeNumber' in item && item.mediaType === 'episode' && item.episodeNumber != null
          ? `${item.episodeNumber}. ${baseTitle}`
          : baseTitle}
      <PosterCard itemId={item.id} title={displayTitle} folder={item.type === 'folder'}
        episode={item.mediaType === 'episode'} episodeWatched={item.watched}
        src={item.posterPath ? getAssetUrl(item.posterPath + (item._v ? `?v=${item._v}` : '')) : undefined}
        watched={shouldBeGreyedOut(item, parentItem, grayOutWatched)} missing={item.isMissing}
        onOpen={() => onItemClick(item)}
        onMenu={(event) => onShowContextMenu(item, event, { layout: 'grid', parentItem })} />
    {/each}
  {:else}
    <p class="empty-message">No items match your filter.</p>
  {/if}
</div>


<style>
  .media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--local-grid-poster-size, var(--grid-poster-size, 155px))), 1fr));
    gap: clamp(.65rem, 1.4vw, 1.15rem);
    padding: .35rem 0 .65rem;
    width: 100%;
    align-content: start;
  }
  .empty-message { padding: .9rem 0; color: var(--color-text-soft); font-size: .87rem; }
</style>
