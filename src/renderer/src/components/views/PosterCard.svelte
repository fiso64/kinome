<script lang="ts">
  import WatchedIndicator from '@components/ui/WatchedIndicator.svelte'
  import Icon from '@components/ui/Icon.svelte'

  let { title, src, folder, episode = false, watched, showWatched = false, missing, onOpen, onMenu }: {
    title: string
    src?: string
    folder: boolean
    watched: boolean
    episode?: boolean
    showWatched?: boolean
    missing?: boolean
    onOpen: () => void
    onMenu: (event: MouseEvent) => void
  } = $props()
</script>

<button type="button" class="poster-card interactive-card" class:watched class:missing class:thumbnail-action={episode}
  aria-label={title + (showWatched ? ', watched' : '') + (missing ? ', missing' : '')} onclick={onOpen} oncontextmenu={onMenu}>
  <div class="artwork">
    {#if src}
      <img {src} alt="" loading="lazy" decoding="async" />
    {:else}
      <div class="placeholder"><Icon name={folder ? 'folder' : 'film'} size={34} /></div>
    {/if}
    {#if showWatched}<span class="watched-mark"><WatchedIndicator /></span>{/if}
    {#if missing}<span class="missing-mark"><Icon name="warning" size={15} /></span>{/if}
  </div>
  <span class="title" {title}>{title}</span>
</button>

<style>
  .poster-card {
    width: 100%;
    min-width: 0;
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
  .watched-mark { position: absolute; inset: .44rem auto auto .44rem; display: flex; }
  .missing img { filter: grayscale(1) brightness(.75); }
  .missing-mark { position: absolute; inset: .44rem .44rem auto auto; display: grid; place-items: center; width: 25px; aspect-ratio: 1; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-inset); color: var(--color-danger-soft); }
</style>
