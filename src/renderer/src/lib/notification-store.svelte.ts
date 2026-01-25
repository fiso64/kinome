// Using Svelte 5 runes for state management
export interface Notification {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

let notifications = $state<Notification[]>([])

function add(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 3000) {
  const id = crypto.randomUUID()
  // Svelte 5 proxy push
  notifications.push({ id, message, type })
  
  setTimeout(() => {
    remove(id)
  }, duration)
}

function remove(id: string) {
  const index = notifications.findIndex((n) => n.id === id)
  if (index !== -1) {
    notifications.splice(index, 1)
  }
}

export const notificationStore = {
  get notifications() {
    return notifications
  },
  add,
  remove
}