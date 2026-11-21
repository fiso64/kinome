<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'
  import type { CascadableViewSettings, EditableViewSettings, Settings, ViewLayout } from '@shared/types'

  let {
    typeKey,
    editCapability = 'editSettings',
    title,
    initialSettings,
    onClose,
    onDone,
    groupByKeys,
    availableLayouts,
    showClickAction,
    settings
  }: {
    typeKey: '_default' | 'movie' | 'tv' | 'season'
    editCapability?: 'editSettings' | 'editMetadata'
    title: string
    initialSettings: CascadableViewSettings
    onClose: () => void
    onDone: (newSettings: CascadableViewSettings) => void
    groupByKeys: string[]
    availableLayouts?: ViewLayout[]
    showClickAction?: boolean
    settings: Settings | null
  } = $props()

  let viewSettings = $state<EditableViewSettings>($state.snapshot(initialSettings))

  function handleDone() {
    const cleaned = Object.fromEntries(
      Object.entries(viewSettings).filter(([, v]) => v != null)
    ) as CascadableViewSettings
    onDone(cleaned)
    onClose()
  }
</script>

<ModalWindow {title} {onClose} onDone={handleDone} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    {typeKey}
    {editCapability}
    {settings}
    bind:viewSettings
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
  />
</ModalWindow>
