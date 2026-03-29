<script lang="ts">
  import ModalWindow from './_base/ModalWindow.svelte'
  import ViewConfigurator from '../ui/ViewConfigurator.svelte'
  import type { CascadableViewSettings, EditableViewSettings, Settings, ViewLayout } from '@shared/types'

  let {
    typeKey,
    title,
    initialSettings,
    onClose,
    onSave,
    groupByKeys,
    availableLayouts,
    showClickAction,
    settings
  }: {
    typeKey: '_default' | 'movie' | 'tv' | 'season'
    title: string
    initialSettings: CascadableViewSettings
    onClose: () => void
    onSave: (newSettings: CascadableViewSettings) => void
    groupByKeys: string[]
    availableLayouts?: ViewLayout[]
    showClickAction?: boolean
    settings: Settings | null
  } = $props()

  let viewSettings = $state<EditableViewSettings>({ ...initialSettings })

  function handleSave() {
    const cleaned = Object.fromEntries(
      Object.entries(viewSettings).filter(([, v]) => v != null)
    ) as CascadableViewSettings
    onSave(cleaned)
    onClose()
  }
</script>

<ModalWindow {title} {onClose} onSave={handleSave} maxWidth="700px" zIndex={101}>
  <ViewConfigurator
    {typeKey}
    {settings}
    bind:viewSettings
    {groupByKeys}
    {availableLayouts}
    {showClickAction}
  />
</ModalWindow>
