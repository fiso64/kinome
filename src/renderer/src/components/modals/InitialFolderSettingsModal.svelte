<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ConfigurableTreeItem from './_parts/ConfigurableTreeItem.svelte'

  type ItemSettings = { retrieve: boolean; hint?: 'movie' | 'tv' }

  let {
    root,
    onClose,
    onApply
  }: {
    root: MediaFolder
    onClose: () => void
    onApply: (settings: { id: string; retrieve: boolean; hint?: 'movie' | 'tv' }[]) => Promise<void>
  } = $props()

  let settings = $state(new Map<string, ItemSettings>())
  let isSaving = $state(false)

  async function handleSave() {
    isSaving = true
    const settingsArray = Array.from(settings.entries()).map(([id, value]) => ({ id, ...value }))
    await onApply(settingsArray)
    isSaving = false
    onClose()
  }
</script>

<ModalWindow
  title="Configure Metadata Retrieval"
  {onClose}
  onSave={handleSave}
  saveText={isSaving ? 'Applying...' : 'Apply & Fetch'}
  maxWidth="800px"
>
  <div class="content">
    <p class="help-text">
      Your library has been scanned. Select which folders should have metadata (posters, overviews,
      etc.) automatically fetched for their children. This can be changed later in Folder Settings.
    </p>
    <div class="tree-container">
      <ConfigurableTreeItem item={root} bind:settings />
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .help-text {
    font-size: 0.9rem;
    color: var(--ev-c-text-2);
    line-height: 1.5;
  }
  .tree-container {
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 6px;
    padding: 0.5rem;
    max-height: 50vh;
    overflow-y: auto;
  }
</style>
