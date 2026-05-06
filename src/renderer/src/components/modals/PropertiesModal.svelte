<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
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

  function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes'

    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
  }

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

<ModalWindow title="Properties" {onClose} saveText="OK" onSave={onClose} cancelText={null}>
  <div class="content">
    {#if isLoading}
      <p>Loading properties...</p>
    {:else if error}
      <p class="error-text">{error}</p>
    {:else if properties}
      <div class="prop-grid">
        <div class="prop-icon">
          {properties.type === 'Folder' ? '📁' : '📄'}
        </div>
        <div class="prop-name">
          {properties.name}
        </div>

        <div class="separator"></div>

        <div class="prop-label">Type:</div>
        <div class="prop-value">{properties.type}</div>

        <div class="prop-label">Path:</div>
        <div class="prop-value path">{properties.path}</div>

        <div class="separator"></div>

        <div class="prop-label">Size:</div>
        <div class="prop-value">
          {formatBytes(properties.size)} ({properties.size.toLocaleString()} bytes)
        </div>

        {#if properties.contains}
          <div class="prop-label">Contains:</div>
          <div class="prop-value">
            {properties.contains.files.toLocaleString()} Files, {properties.contains.folders.toLocaleString()}
            Folders
          </div>
        {/if}

        <div class="separator"></div>

        <div class="prop-label">Created:</div>
        <div class="prop-value">{new Date(properties.created).toLocaleString()}</div>

        <div class="prop-label">Modified:</div>
        <div class="prop-value">{new Date(properties.modified).toLocaleString()}</div>
      </div>
    {/if}
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    min-height: 200px;
  }
  .error-text {
    color: #e81123;
  }
  .prop-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem 1rem;
    align-items: center;
  }
  .prop-icon {
    grid-column: 1;
    font-size: 2.5rem;
  }
  .prop-name {
    grid-column: 2;
    font-size: 1.2rem;
    font-weight: bold;
    word-break: break-all;
  }
  .separator {
    grid-column: 1 / -1;
    height: 1px;
    background-color: var(--color-background-mute);
    margin: 0.5rem 0;
  }
  .prop-label {
    font-weight: bold;
    text-align: right;
  }
  .prop-value {
    word-break: break-all;
  }
  .prop-value.path {
    font-family: monospace;
    font-size: 0.9em;
  }
</style>
