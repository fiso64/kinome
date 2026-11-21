<script lang="ts">
  import type { Snippet } from 'svelte'
  import { flip } from 'svelte/animate'
  import { prefersReducedMotion } from 'svelte/motion'
  import type { MediaSource } from '@shared/types'
  import { api } from '@lib/api'
  import { useDragSort } from '@lib/drag-sort.svelte'
  import Icon from '@components/ui/Icon.svelte'

  type Preview = { path: string; exists: boolean; error?: boolean }
  type CachedPath = { sourcePath: string; isRelative: boolean; libraryLocation: string; preview: Preview }

  let {
    sources = $bindable(),
    libraryLocation,
    disabled = false,
    shadowSources = $bindable(),
    shadowMinDepth = $bindable(),
    resolvedPaths = $bindable({}),
    onRemove,
    rootOptions
  }: {
    sources: MediaSource[]
    libraryLocation: string
    disabled?: boolean
    shadowSources: boolean
    shadowMinDepth: number
    resolvedPaths?: Record<string, Preview>
    onRemove?: (id: string) => void
    rootOptions?: Snippet<[MediaSource, string]>
  } = $props()

  const id = $props.id()
  const drag = useDragSort(() => sources, (items) => (sources = items))
  const cache = new Map<string, CachedPath>()

  $effect(() => {
    if (disabled) {
      resolvedPaths = {}
      return
    }
    const location = libraryLocation
    const activeIds = new Set(sources.map((source) => source.id))
    for (const key of cache.keys()) if (!activeIds.has(key)) cache.delete(key)

    const known: Record<string, Preview> = {}
    const missing: MediaSource[] = []
    for (const source of sources) {
      const { id, path, isRelative } = source
      if (!path.trim()) continue

      const cached = cache.get(id)
      if (cached && cached.sourcePath === path && cached.isRelative === isRelative &&
        (!isRelative || cached.libraryLocation === location)) {
        known[id] = cached.preview
      } else {
        missing.push({ id, path, isRelative })
      }
    }

    resolvedPaths = known
    if (!missing.length) return

    let cancelled = false
    const timer = setTimeout(async () => {
      const updates = await Promise.all(missing.map(async (source) => {
        try {
          const preview = await api.resolveMediaSourcePath({
            path: source.path, isRelative: source.isRelative, libraryLocation: location
          })
          return { source, preview }
        } catch {
          return { source, preview: { path: '', exists: false, error: true } }
        }
      }))

      if (cancelled) return
      for (const { source, preview } of updates) {
        known[source.id] = preview
        if (!('error' in preview)) {
          cache.set(source.id, {
            sourcePath: source.path, isRelative: source.isRelative, libraryLocation: location, preview
          })
        }
      }
      resolvedPaths = { ...known }
    }, 160)

    return () => { cancelled = true; clearTimeout(timer) }
  })

  function addSource() {
    sources = [...sources, { id: crypto.randomUUID(), path: '', isRelative: false }]
  }

  function removeSource(id: string) {
    sources = sources.filter((source) => source.id !== id)
    onRemove?.(id)
  }

  function moveSource(index: number, offset: number) {
    const next = [...sources]
    const [source] = next.splice(index, 1)
    next.splice(index + offset, 0, source)
    sources = next
  }

  function updateShadowDepth(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    if (Number.isFinite(input.valueAsNumber)) {
      shadowMinDepth = Math.max(1, Math.min(10, Math.trunc(input.valueAsNumber)))
    }
  }
</script>

<div class="source-editor">
  {#each sources as source, index (source.id)}
    {@const preview = resolvedPaths[source.id]}
    <section class="source-card raised-surface" class:drag-placeholder={drag.draggedIndex === index}
      use:drag.item={index} animate:flip={{ duration: prefersReducedMotion.current ? 0 : 155 }}>
      <header class="source-heading">
        {#if sources.length > 1 && !disabled}
          <span class="drag-handle" title="Drag to reorder" use:drag.handle={index}><Icon name="grip" size={16} /></span>
        {:else}
          <span class="source-icon"><Icon name="folder" size={16} /></span>
        {/if}
        <h3>{source.name || (sources.length > 1 ? `Source ${index + 1}` : 'Media source')}</h3>
        {#if sources.length > 1}
          <button type="button" class="icon-button" aria-label={`Move source ${index + 1} up`} disabled={index === 0}
            onclick={() => moveSource(index, -1)}><Icon name="up" size={15} /></button>
          <button type="button" class="icon-button" aria-label={`Move source ${index + 1} down`} disabled={index === sources.length - 1}
            onclick={() => moveSource(index, 1)}><Icon name="down" size={15} /></button>
          <button type="button" class="icon-button remove-source" aria-label={`Remove source ${index + 1}`}
            onclick={() => removeSource(source.id)}><Icon name="trash" size={15} /></button>
        {/if}
      </header>

      <input type="text" aria-label={`Path for source ${index + 1}`}
        bind:value={source.path} placeholder="/path/to/media" />
      <label class="relative-option"><input type="checkbox" bind:checked={source.isRelative} /> Relative to library data parent</label>
      {#if preview?.error}
        <p class="form-hint path-error">Could not resolve this path.</p>
      {:else if preview?.path && (source.isRelative || preview.path !== source.path || !preview.exists)}
        <p class="form-hint"><code>{preview.path}</code>{#if !preview.exists} <span class="path-warning">Folder doesn't exist yet.</span>{/if}</p>
      {/if}
      {#if rootOptions && preview?.exists && preview.path}
        {@render rootOptions(source, preview.path)}
      {/if}
    </section>
  {/each}

  <button class="add-source" type="button" onclick={addSource}><Icon name="plus" size={16} /> Add source</button>

  {#if sources.length > 1}
    <section class="source-card raised-surface">
      <label class="relative-option"><input type="checkbox" bind:checked={shadowSources} /> Skip duplicate folders across sources</label>
      {#if shadowSources}
        <div class="shadow-depth">
          <label for={id}>Minimum folder depth</label>
          <input type="number" {id} min="1" max="10" value={shadowMinDepth} oninput={updateShadowDepth} />
        </div>
      {/if}
      <p class="form-hint">Earlier sources take priority when the same folder exists in more than one source.</p>
    </section>
  {/if}
</div>

<style>
  .source-editor, .source-card { display: grid; gap: .65rem; min-width: 0; }
  .source-card { padding: .65rem .75rem; }
  .source-card.drag-placeholder { opacity: .28; }
  .source-heading { display: flex; gap: .25rem; align-items: center; min-width: 0; }
  .source-heading h3 { flex: 1; min-width: 0; font-size: .88rem; font-weight: 660; overflow-wrap: anywhere; }
  .source-heading .icon-button { width: 27px; height: 27px; }
  .drag-handle, .source-icon { flex: none; display: flex; margin-right: .25rem; color: var(--color-primary-soft); }
  .remove-source:hover, .path-error { color: var(--color-danger-soft); }
  .path-warning { color: var(--color-primary-soft); }
  .relative-option { display: flex; gap: .4rem; align-items: center; font-size: .85rem; }
  .relative-option input { flex: none; }
  .shadow-depth { display: flex; align-items: center; flex-wrap: wrap; gap: .45rem; font-size: .83rem; }
  .shadow-depth input { width: 4rem; }
  .add-source { display: inline-flex; align-items: center; gap: .3rem; justify-self: start; }
  code { overflow-wrap: anywhere; }
</style>
