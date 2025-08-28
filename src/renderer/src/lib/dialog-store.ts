import { writable } from 'svelte/store'

export type DialogButton = {
  label: string
  value: any
  class?: 'primary' | 'secondary' | 'danger'
}

export type CheckboxConfig = {
  label: string
  checked: boolean
}

type DialogConfig = {
  title: string
  message: string
  detail?: string
  buttons: DialogButton[]
  checkbox?: CheckboxConfig
  resolve: (value: any) => void
}

const { subscribe, update } = writable<DialogConfig[]>([])

function showDialog(dialog: Omit<DialogConfig, 'resolve'>): Promise<any> {
  return new Promise((resolve) => {
    const newDialog = { ...dialog, resolve }
    update((queue) => [...queue, newDialog])
  })
}

function closeDialog(value: any) {
  update((queue) => {
    const currentDialog = queue.shift()
    if (currentDialog) {
      currentDialog.resolve(value)
    }
    return queue
  })
}

// Public API for the store
export const dialogStore = {
  subscribe,
  showDialog,
  close: closeDialog, // For closing via Escape key or backdrop click
  showConfirmation: (options: {
    title: string
    message: string
    detail?: string
    confirmText?: string
    cancelText?: string
    confirmClass?: 'primary' | 'danger'
  }): Promise<boolean> => {
    return showDialog({
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [
        { label: options.cancelText ?? 'Cancel', value: false, class: 'secondary' },
        {
          label: options.confirmText ?? 'Confirm',
          value: true,
          class: options.confirmClass ?? 'primary'
        }
      ]
    }).then((value) => !!value) // Coerce to boolean
  },
  showError: (options: { title: string; message: string; detail?: string }): Promise<void> => {
    return showDialog({
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [{ label: 'OK', value: undefined, class: 'primary' }]
    })
  },
  showConfirmationWithCheckbox: (options: {
    title: string
    message: string
    detail?: string
    confirmText?: string
    cancelText?: string
    confirmClass?: 'primary' | 'danger'
    checkbox: { label: string; checked: boolean }
  }): Promise<{ confirmed: boolean; checkboxValue: boolean }> => {
    return showDialog({
      title: options.title,
      message: options.message,
      detail: options.detail,
      checkbox: { label: options.checkbox.label, checked: options.checkbox.checked },
      buttons: [
        { label: options.cancelText ?? 'Cancel', value: false, class: 'secondary' },
        {
          label: options.confirmText ?? 'Confirm',
          value: true,
          class: options.confirmClass ?? 'primary'
        }
      ]
    }).then((result) => {
      // The result from the dialog will now be an object like { value: boolean, checkboxValue: boolean }
      if (typeof result === 'object' && result !== null && 'value' in result) {
        return { confirmed: !!result.value, checkboxValue: result.checkboxValue }
      }
      // This is a fallback in case something goes wrong, but shouldn't be hit with the new explicit logic
      return { confirmed: !!result, checkboxValue: false }
    })
  }
}
