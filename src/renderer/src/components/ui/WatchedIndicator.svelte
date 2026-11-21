<script lang="ts">
  import { api } from '@lib/api'
  import { notificationStore } from '@lib/notification-store.svelte'
  import { libraryDataService } from '@lib/services/library-data-service.svelte'
  import Icon from './Icon.svelte'

  let { itemId, title, watched }: { itemId: string; title: string; watched?: boolean | null } = $props()

  let pending = $state(false)
  let requested = $state<boolean>()
  const checked = $derived(requested ?? Boolean(watched))

  $effect(() => {
    if (requested !== undefined && requested === Boolean(watched)) requested = undefined
  })

  async function toggle() {
    if (pending) return
    const next = !checked
    requested = next
    pending = true
    try {
      if (next) await api.markAsWatched(itemId)
      else await api.markAsUnwatched(itemId)
      if (!api.getIsWebSocketConnected()) libraryDataService.invalidateAllQueries()
    } catch (error) {
      requested = undefined
      notificationStore.add(error instanceof Error ? error.message : 'Could not update watched status.', 'error')
    } finally {
      pending = false
    }
  }
</script>

<button type="button" class="watched-toggle" aria-label={`Watched: ${title}`} aria-pressed={checked}
  aria-disabled={pending} title={checked ? 'Mark as unwatched' : 'Mark as watched'} onclick={toggle}>
  <span class="watched-indicator" class:checked aria-hidden="true">
    {#if checked}<Icon name="check" size={14} />{/if}
  </span>
</button>

<style>
  .watched-toggle {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    box-shadow: none;
  }
  .watched-toggle:hover, .watched-toggle:active { background: transparent; box-shadow: none; transform: none; }
  .watched-indicator {
    display: inline-grid;
    place-items: center;
    width: 21px;
    height: 21px;
    color: var(--color-text-soft);
    background: var(--color-inset);
    border: 1px solid #a2a5ae66;
    border-radius: 50%;
    box-shadow: var(--edge-light);
  }
  .watched-indicator.checked, .watched-toggle:hover .watched-indicator { background: var(--color-background-mute); }
  .watched-indicator.checked { border-color: #a2a5ae4a; }
  .watched-toggle:is(:hover, :focus-visible) .watched-indicator { border-color: var(--color-text-soft); }
</style>
