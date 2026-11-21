<script lang="ts">
  import type { Settings } from '@shared/types'
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'

  let {
    initialSettings,
    onClose,
    onDone,
    settings
  }: {
    initialSettings: Settings['defaultLayoutSettings'] | null
    onClose: () => void
    onDone: (newSettings: Settings['defaultLayoutSettings']) => void
    settings: Settings | null
  } = $props()

  let localSettings = $state($state.snapshot(initialSettings))
  let activeLayout = $state<keyof Settings['defaultLayoutSettings']>('grid')

  function handleDone() {
    if (localSettings) {
      onDone($state.snapshot(localSettings))
    }
    onClose()
  }
</script>

<ModalWindow
  title="Default Layout Values"
  {onClose}
  onDone={handleDone}
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
