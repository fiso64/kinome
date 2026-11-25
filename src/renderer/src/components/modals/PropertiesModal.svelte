<script lang="ts">
  import Skeleton from '@components/ui/Skeleton.svelte'
  import Icon from '@components/ui/Icon.svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import { formatBytes } from '@lib/view-helpers'
  import type { LibraryItem } from '@shared/types'

  type ItemProperties = {
    name: string
    path: string
    type: 'File' | 'Folder'
    size: number
    created: string
    modified: string
    contains?: { files: number; folders: number }
  }

  let {
    item,
    onClose
  }: {
    item: LibraryItem
    onClose: () => void
  } = $props()

  let properties = $state<ItemProperties | null>(null)
  let isLoading = $state(true)
  let error = $state<string | null>(null)

  $effect(() => {
    const fetchProperties = async () => {
      if (item.isVirtual) {
        error = 'This item does not have a physical path on the disk (e.g., virtual item).'
        isLoading = false
        return
      }
      try {
        isLoading = true
        const props = await window.api.getItemProperties(item.id)
        if (props) {
          properties = props
        } else {
          error = 'Could not retrieve item properties.'
        }
      } catch (e) {
        console.error('Failed to get item properties:', e)
        error = (e as Error).message || 'An unknown error occurred.'
      } finally {
        isLoading = false
      }
    }
    fetchProperties()
  })
</script>

<ModalWindow title="Properties" {onClose} cancelText="Close" maxWidth="535px">
  <div class="form-stack" aria-busy={isLoading}>
    {#if isLoading}
      <div class="loading-properties" role="status" aria-label="Loading properties">
        <Skeleton height="2.25rem" />
        <Skeleton width="55%" />
        <Skeleton width="80%" />
      </div>
    {:else if error}
      <p class="error-text" role="alert">{error}</p>
    {:else if properties}
      <div class="property-title">
        <span class="property-icon"><Icon name={properties.type === 'Folder' ? 'folder' : 'file'} size={22} /></span>
        <div>
          <h3>{properties.name}</h3>
          <p class="form-hint">{properties.type}</p>
        </div>
      </div>

      <div class="form-field">
        <span class="field-label">Path</span>
        <code>{properties.path}</code>
      </div>

      <dl class="property-list">
        <dt>Size</dt>
        <dd>{formatBytes(properties.size)} <span class="form-hint">({properties.size.toLocaleString()} bytes)</span></dd>
        {#if properties.contains}
          <dt>Contents</dt>
          <dd>{properties.contains.files.toLocaleString()} files, {properties.contains.folders.toLocaleString()} folders</dd>
        {/if}
        <dt>Created</dt>
        <dd>{new Date(properties.created).toLocaleString()}</dd>
        <dt>Modified</dt>
        <dd>{new Date(properties.modified).toLocaleString()}</dd>
      </dl>
    {/if}
  </div>
</ModalWindow>

<style>
  .loading-properties { display: grid; gap: .6rem; }
  .error-text { color: var(--color-danger-soft); font-size: .9rem; }
  .property-title { display: flex; align-items: center; gap: .65rem; min-width: 0; overflow-wrap: anywhere; }
  .property-title h3 { font-size: 1rem; font-weight: 650; }
  .property-icon { display: grid; place-items: center; flex: 0 0 40px; height: 40px;
    background: var(--accent-surface); border: 1px solid var(--accent-border); border-radius: var(--radius-field); color: var(--color-primary-soft); }
  code { padding: .55rem .65rem; background: var(--color-inset); border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-field); font-size: .84rem; overflow-wrap: anywhere; }
  .property-list { display: grid; grid-template-columns: max-content minmax(0, 1fr);
    gap: .45rem .85rem; padding-top: .65rem; font-size: .86rem; background: var(--section-rule) 0 0 / 100% 1px no-repeat; }
  dt { color: var(--color-text-soft); font-weight: 600; }
  dd { min-width: 0; overflow-wrap: anywhere; }
</style>
