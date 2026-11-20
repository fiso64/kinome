<script lang="ts">
  import type { Settings } from '@shared/types'
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'

  let {
    initialSettings,
    onClose,
    onSave,
    settings
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onSave: (newSettings: Settings['defaultLayoutSettings']) => void
    settings: Settings | null
  } = $props()

  let localSettings = $state($state.snapshot(initialSettings))
  let activeLayout = $state<keyof Settings['defaultLayoutSettings']>('grid')

  function handleSave() {
    if (localSettings) {
      onSave(localSettings)
    }
    onClose()
  }
</script>

<ModalWindow
  title="Default Layout Values"
  {onClose}
  onSave={handleSave}
  maxWidth="700px"
  zIndex={101}
>
  {#if localSettings}
    <ViewConfigurator
      configMode={true}
      {settings}
      bind:activeConfigLayout={activeLayout}
      bind:viewSettings={localSettings[activeLayout]}
    />
  {/if}
</ModalWindow>
