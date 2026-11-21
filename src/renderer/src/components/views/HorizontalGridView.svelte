<script lang="ts">
  import PosterCard from './PosterCard.svelte'
  import ScrollableGrid from './ScrollableGrid.svelte'
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
    gridPosterSize,
    showHorizontalScrollbar
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
    showHorizontalScrollbar?: boolean
  } = $props()


</script>

<ScrollableGrid stateKey="h-grid" hasItems={items.length > 0} columnWidth={gridPosterSize}
  showScrollbar={showHorizontalScrollbar}>
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
        onMenu={(event) => onShowContextMenu(item, event, { layout: 'horizontal-grid', parentItem })} />
  {/each}
</ScrollableGrid>
