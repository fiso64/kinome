<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ShortcutReference from '@components/ui/ShortcutReference.svelte'

  let { onClose }: { onClose: () => void } = $props()
</script>

<ModalWindow title="Keyboard shortcuts" {onClose} cancelText="Close" maxWidth="960px">
  <div class="shortcuts-body"><ShortcutReference /></div>
</ModalWindow>

<style>
  .shortcuts-body { padding: clamp(.85rem, 2.7vw, 1.35rem); }
</style>
