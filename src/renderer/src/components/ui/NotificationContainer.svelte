<script lang="ts">
  import { notificationStore } from '@lib/notification-store.svelte'
  import { flip } from 'svelte/animate'
  import { fade, fly } from 'svelte/transition'
</script>

<div class="notification-container">
  {#each notificationStore.notifications as notification (notification.id)}
    <div
      class="notification {notification.type}"
      animate:flip={{ duration: 300 }}
      in:fly={{ y: 20, duration: 300 }}
      out:fade={{ duration: 200 }}
    >
      {notification.message}
    </div>
  {/each}
</div>

<style>
  .notification-container {
    position: fixed;
    bottom: 2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5000; /* Extremely high z-index to sit on top of modals/dialogs */
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none; /* Let clicks pass through gaps */
  }

  .notification {
    background-color: var(--ev-c-black-soft);
    color: var(--ev-c-text-1);
    border: 1px solid var(--ev-c-gray-2);
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    font-size: 0.95rem;
    font-weight: 500;
    pointer-events: auto; /* Re-enable clicks on the toasts themselves if needed */
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 300px;
    text-align: center;
  }

  .notification.success {
    border-color: #10b981; /* Green */
    color: #ecfdf5;
  }

  .notification.error {
    border-color: #ef4444; /* Red */
    color: #fef2f2;
  }
</style>
