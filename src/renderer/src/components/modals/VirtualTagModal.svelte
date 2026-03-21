<script lang="ts">
  import type { VirtualTagConfig, AutocompleteSuggestions } from '@shared/types'
  import ModalWindow from './_base/ModalWindow.svelte'
  import VirtualTagEditor from './_parts/VirtualTagEditor.svelte'

  let {
    tag,
    suggestions,
    onClose,
    onSave
  }: {
    tag: VirtualTagConfig
    suggestions?: AutocompleteSuggestions
    onClose: () => void
    onSave: (updated: VirtualTagConfig) => void
  } = $props()

  let draft = $state<VirtualTagConfig>(JSON.parse(JSON.stringify(tag)))

  function handleSave() {
    onSave(draft)
    onClose()
  }
</script>

<ModalWindow title="Edit Virtual Tag" {onClose} onSave={handleSave} maxWidth="700px">
  <VirtualTagEditor bind:tag={draft} {suggestions} onDelete={onClose} />
</ModalWindow>
