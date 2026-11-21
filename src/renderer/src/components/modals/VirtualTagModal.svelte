<script lang="ts">
  import type { VirtualTagConfig, AutocompleteSuggestions } from '@shared/types'
  import { dialogStore } from '@lib/dialog-store'
  import ModalWindow from './_base/ModalWindow.svelte'
  import VirtualTagEditor from './_parts/VirtualTagEditor.svelte'

  let {
    tag,
    suggestions,
    onClose,
    onDone
  }: {
    tag: VirtualTagConfig
    suggestions?: AutocompleteSuggestions
    onClose: () => void
    onDone: (updated: VirtualTagConfig) => void
  } = $props()

  let draft = $state<VirtualTagConfig>($state.snapshot(tag))

  function handleDone() {
    const name = draft.name.trim()
    if (!name || draft.cases.length === 0) {
      dialogStore.showError({ title: 'Incomplete Virtual Tag', message: 'Enter a name and add at least one case.' })
      return
    }
    onDone({ ...$state.snapshot(draft), name })
    onClose()
  }
</script>

<ModalWindow title="Virtual tag" {onClose} onDone={handleDone} maxWidth="700px">
  <VirtualTagEditor bind:tag={draft} {suggestions} />
</ModalWindow>
