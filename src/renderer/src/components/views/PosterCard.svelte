<script lang="ts">
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'

  let { itemId, title, src, folder, episode = false, watched, episodeWatched, missing, onOpen, onMenu }: {
    itemId: string
    title: string
    src?: string
    folder: boolean
    watched: boolean
    episode?: boolean
    episodeWatched?: boolean
    missing?: boolean
    onOpen: () => void
    onMenu: (event: MouseEvent) => void
  } = $props()
</script>

<div class="poster-card-shell interactive-card" class:episode data-media-item-id={itemId}>
  <button type="button" class="poster-card" class:watched class:missing class:thumbnail-action={episode}
    aria-label={title + (missing ? ', missing' : '')} onclick={onOpen} oncontextmenu={onMenu}>
    <div class="artwork">
      {#if src}
        <img {src} alt="" loading="lazy" decoding="async" />
      {:else}
        <div class="placeholder"><Icon name={folder ? 'folder' : 'film'} size={34} /></div>
      {/if}
      {#if missing}<span class="missing-mark"><Icon name="warning" size={15} /></span>{/if}
    </div>
    <span class="title" {title}>{title}</span>
  </button>
  {#if episode}
    <div class="watched-mark"><WatchedIndicator {itemId} {title} watched={episodeWatched} /></div>
  {/if}
</div>

<style>
  .poster-card-shell { position: relative; min-width: 0; }
  .poster-card {
    width: 100%;
    min-width: 0;
    height: 100%;
    padding: 0;
    display: grid;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-panel);
    background: var(--surface-raised);
    color: var(--color-text);
    box-shadow: var(--edge-light), 0 4px 12px #0004;
    text-align: start;
    overflow: hidden;
  }
  .poster-card:hover:not(:disabled) { border-color: #918477; box-shadow: var(--edge-light), 0 6px 18px #0008; }
  .artwork { position: relative; width: 100%; aspect-ratio: 2 / 3; overflow: hidden; background: var(--color-inset); }
  .artwork img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: var(--color-text-dim); background: radial-gradient(at 15% 0%, #35343c, transparent 65%); }
  .title { min-width: 0; padding: .58rem .65rem .66rem; font-size: .86rem; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .watched:not(:is(:hover, :focus-visible)) :is(img, .title, .placeholder) { opacity: .63; }
  .watched-mark { position: absolute; inset-block-start: .2rem; inset-inline-end: .2rem; }
  .missing img { filter: grayscale(1) brightness(.75); }
  .missing-mark { position: absolute; inset-block-start: .44rem; inset-inline-end: .44rem; display: grid; place-items: center; width: 25px; aspect-ratio: 1; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-inset); color: var(--color-danger-soft); }
  .poster-card-shell.episode .missing-mark { inset-inline: .44rem auto; }
  /* Phones: the rounded poster with its title below, without a card around them. */
  @media (max-width: 600px) {
    .poster-card { gap: .3rem; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
    .poster-card:hover:not(:disabled) { box-shadow: none; }
    .artwork { border: 1px solid var(--color-border-soft); border-radius: var(--radius-field); }
    .title { padding: 0 .15rem; font-size: .8rem; font-weight: 600; }
  }
</style>
