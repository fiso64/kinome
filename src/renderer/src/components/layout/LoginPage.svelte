<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import Skeleton from '@components/ui/Skeleton.svelte'

  type UserEntry = { id: string; username: string }

  function avatarHue(username: string): number {
    let hash = 2166136261
    for (let index = 0; index < username.length; index++) {
      hash = Math.imul(hash ^ username.charCodeAt(index), 16777619)
    }
    return (hash >>> 0) * 360 / 2 ** 32
  }

  let users = $state<UserEntry[]>([])
  let loadingUsers = $state(true)
  let usersError = $state(false)
  let selectedUser = $state<UserEntry | null>(null)
  let password = $state('')
  let error = $state('')
  let loading = $state(false)

  // Setup mode state
  let setupMode = $state(false)
  let setupUsername = $state('')
  let setupPassword = $state('')
  let setupToken = $state('')

  onMount(() => {
    setupMode = authStore.needsSetup
    if (!setupMode) void loadUsers()
  })

  async function loadUsers() {
    loadingUsers = true
    usersError = false
    try {
      const res = await fetch('/api/users')
      if (!res.ok) throw new Error('Could not load profiles.')
      users = await res.json()
    } catch {
      usersError = true
    } finally {
      loadingUsers = false
    }
  }

  function selectUser(user: UserEntry) {
    selectedUser = user
    password = ''
    error = ''
  }

  function back() {
    selectedUser = null
    password = ''
    error = ''
  }

  async function handleLogin() {
    if (!selectedUser || loading) return
    loading = true
    error = ''
    try {
      const result = await authStore.login(selectedUser.username, password)
      if (!result.success) error = result.message || 'Incorrect password.'
    } catch {
      error = 'Could not reach the server.'
    } finally {
      loading = false
    }
  }

  async function handleSetup() {
    if (loading) return
    loading = true
    error = ''
    try {
      const result = await authStore.setupAdmin(setupToken, setupUsername, setupPassword)
      if (!result.success) error = result.message || 'Could not create the account.'
    } catch {
      error = 'Could not reach the server.'
    } finally {
      loading = false
    }
  }

  function focusPassword(node: HTMLInputElement) {
    queueMicrotask(() => {
      if (node.isConnected) node.focus()
    })
  }
</script>

<div class="page">
  <section class="auth-card glass-surface" aria-labelledby="auth-heading">
    <div class="brand" aria-hidden="true">
      <span class="brand-icon"><Icon name="brand" size={24} /></span>
      <span>Kinome</span>
    </div>

    {#if setupMode}
      <form class="auth-flow" in:fade={{ duration: prefersReducedMotion.current ? 0 : 135 }}
        onsubmit={(event) => { event.preventDefault(); void handleSetup() }}>
        <h1 id="auth-heading">Create an admin account</h1>
        <p class="form-hint">Use the setup token printed in the server console.</p>
        <div class="form-field">
          <label for="setup-token">Setup token</label>
          <input id="setup-token" type="text" bind:value={setupToken} disabled={loading} required />
        </div>
        <div class="form-field">
          <label for="setup-username">Username</label>
          <input id="setup-username" type="text" autocomplete="username" bind:value={setupUsername} disabled={loading} required />
        </div>
        <div class="form-field">
          <label for="setup-password">Password</label>
          <input id="setup-password" type="password" autocomplete="new-password" bind:value={setupPassword} disabled={loading} required />
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button type="submit" class="primary" disabled={loading}>{loading ? 'Creating...' : 'Create account'}</button>
      </form>
    {:else if selectedUser}
      <form class="auth-flow" in:fade={{ duration: prefersReducedMotion.current ? 0 : 135 }}
        onsubmit={(event) => { event.preventDefault(); void handleLogin() }}>
        <div class="sign-in-heading">
          {@render avatar(selectedUser.username)}
          <h1 id="auth-heading">{selectedUser.username}</h1>
        </div>
        <input type="text" autocomplete="username" value={selectedUser.username} hidden />
        <div class="form-field">
          <label for="sign-in-password">Password</label>
          <input id="sign-in-password" type="password" autocomplete="current-password"
            bind:value={password} use:focusPassword disabled={loading} required />
        </div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        <button type="submit" class="primary" disabled={loading || !password}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
        <button type="button" class="back-btn" onclick={back}><Icon name="back" size={17} /> Switch account</button>
      </form>
    {:else}
      <div class="auth-flow" in:fade={{ duration: prefersReducedMotion.current ? 0 : 135 }}>
        <h1 id="auth-heading">Choose an account</h1>
        {#if loadingUsers}
          <div role="status" aria-label="Loading accounts"><Skeleton height="3.5rem" /></div>
        {:else if usersError}
          <p class="error" role="alert">Could not load accounts.</p>
          <button type="button" onclick={loadUsers}>Try again</button>
        {:else}
          <div class="user-grid">
            {#each users as user (user.id)}
              <button type="button" class="user-card" onclick={() => selectUser(user)}>
                {@render avatar(user.username)}
                <span class="username">{user.username}</span>
                <Icon name="right" size={16} />
              </button>
            {:else}
              <p class="form-hint">No accounts found.</p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

{#snippet avatar(username: string)}
  <span class="avatar" style:--avatar-hue={avatarHue(username)} aria-hidden="true">
    {username.charAt(0).toUpperCase()}
  </span>
{/snippet}

<style>
  .page {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: 1rem;
    background: radial-gradient(ellipse at 50% 0%, #1c1a17, transparent min(68vh, 620px)), var(--color-background);
  }
  .auth-card { width: min(100%, 27rem); padding: clamp(1rem, 4.5vw, 2.15rem); border-radius: var(--radius-window); }
  .brand {
    display: flex;
    align-items: center;
    gap: .6rem;
    margin-bottom: 1.45rem;
    color: var(--color-primary-soft);
    font-size: .92rem;
    font-weight: 650;
  }
  .brand-icon, .avatar {
    display: grid;
    place-items: center;
    flex: 0 0 38px;
    width: 38px;
    height: 38px;
    border: 1px solid;
    box-shadow: var(--edge-light);
    border-radius: var(--radius-field);
  }
  .brand-icon {
    color: var(--color-primary-soft);
    background: var(--accent-surface);
    border-color: var(--accent-border);
  }
  .avatar {
    color: oklch(0.96 0.025 var(--avatar-hue));
    background: oklch(0.46 0.1 var(--avatar-hue));
    border-color: oklch(0.56 0.09 var(--avatar-hue));
    font-weight: 700;
  }
  .auth-flow, .user-grid { display: grid; gap: .75rem; }
  .auth-flow h1 { font-size: clamp(1.35rem, 5vw, 1.8rem); font-weight: 705; letter-spacing: -.03em; overflow-wrap: anywhere; }
  .user-card, .sign-in-heading { display: flex; align-items: center; gap: .65rem; min-width: 0; }
  .user-card { padding: .45rem .6rem; text-align: left; }
  .username { flex: 1; overflow-wrap: anywhere; }
  .back-btn { display: flex; align-items: center; gap: .35rem; justify-self: start; padding: .2rem 0;
    background: transparent; border-color: transparent; box-shadow: none; color: var(--color-text-soft); }
  .back-btn:hover { background: transparent; color: var(--color-primary-soft); }
  .error { padding: .55rem .65rem; background: #67383655; border: 1px solid #9a414580;
    color: var(--color-danger-soft); border-radius: var(--radius-field); font-size: .85rem; }
</style>
