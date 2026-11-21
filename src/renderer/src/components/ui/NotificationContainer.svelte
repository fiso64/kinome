<script lang="ts">
  import Icon from './Icon.svelte'
  import { notificationStore } from '@lib/notification-store.svelte'
  import { flip } from 'svelte/animate'
  import { fade, fly } from 'svelte/transition'
</script>

<div class="notification-container" aria-live="polite" aria-relevant="additions">
  {#each notificationStore.notifications as notification (notification.id)}
    <div
      class="notification glass-surface {notification.type}"
      animate:flip={{ duration: 300 }}
      in:fly={{ y: 20, duration: 300 }}
      out:fade={{ duration: 200 }}
    >
      <span class="notification-icon"><Icon name={notification.type === 'error' ? 'warning' : notification.type === 'success' ? 'check' : 'info'} size={17} /></span>
      <span>{notification.message}</span>
    </div>
  {/each}
</div>

<style>
  .notification-container {
    position: fixed;
    inset-inline-end: max(1rem, env(safe-area-inset-right));
    inset-block-end: max(1rem, env(safe-area-inset-bottom));
    z-index: 5000;
    display: grid;
    justify-items: end;
    gap: .55rem;
    width: min(calc(100% - 2rem), 25rem);
    pointer-events: none;
  }

  .notification {
    --notification-color: var(--color-primary-soft);
    display: flex;
    align-items: center;
    gap: .65rem;
    padding: .6rem .8rem;
    font-size: .875rem;
    font-weight: 550;
    overflow-wrap: anywhere;
  }

  .notification-icon {
    display: grid;
    place-items: center;
    border-radius: 7px;
    flex: 0 0 29px;
    height: 29px;
    color: var(--notification-color);
    background: color-mix(in srgb, var(--notification-color) 11%, transparent);
  }

  .success { --notification-color: var(--color-success-soft); }
  .error { --notification-color: var(--color-danger-soft); }
</style>
