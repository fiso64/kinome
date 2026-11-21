<script lang="ts">
  import ModalWindow from '@components/modals/_base/ModalWindow.svelte'
  import type { DialogButton, CheckboxConfig } from '@lib/dialog-store'

  let { title, message, detail, buttons, onClose, checkbox }: {
    title: string
    message: string
    detail?: string
    buttons: DialogButton[]
    onClose: (value: any) => void
    checkbox?: CheckboxConfig
  } = $props()

  const descriptionId = $props.id()
  let isChecked = $state(false)
  $effect(() => { isChecked = checkbox?.checked ?? false })

  function finish(value: DialogButton['value']) {
    onClose(checkbox ? { value, checkboxValue: isChecked } : value)
  }

  function cancel() {
    finish(undefined)
  }

  function confirm() {
    const button = buttons.find((button) => button.class === 'primary' || button.class === 'danger') ?? buttons[0]
    if (button) finish(button.value)
  }
</script>

<ModalWindow {title} onClose={cancel} onSave={confirm} cancelText={null} maxWidth="32rem" zIndex={2000}
  role="alertdialog" {descriptionId}>
  <div class="dialog-copy">
    <p id={descriptionId}>{message}</p>
    {#if detail}<p class="dialog-detail">{detail}</p>{/if}
    {#if checkbox}
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={isChecked} />
        <span>{checkbox.label}</span>
      </label>
    {/if}
  </div>
  {#snippet actions()}
    {#each buttons as button (button.label)}
      <button type="button" class={button.class ?? 'secondary'} onclick={() => finish(button.value)}>{button.label}</button>
    {/each}
  {/snippet}
</ModalWindow>

<style>
  .dialog-copy {
    display: grid;
    gap: .7rem;
    padding: 1.25rem;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    user-select: text;
  }
  .dialog-detail { font-size: .865rem; color: var(--color-text-soft); }
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: .7rem;
    padding: .65rem .75rem;
    border: 1px solid var(--color-border-soft);
    border-radius: var(--radius-field);
    background: var(--color-inset);
    font-size: .875rem;
  }
</style>
