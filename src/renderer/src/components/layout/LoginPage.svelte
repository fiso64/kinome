<script lang="ts">
  import Icon from '@components/ui/Icon.svelte'
  import AccountAvatar from '@components/ui/AccountAvatar.svelte'
  import { authStore } from '@lib/auth-store.svelte'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import Skeleton from '@components/ui/Skeleton.svelte'

  type UserEntry = { id: string; username: string }


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
          <AccountAvatar username={selectedUser.username} />
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
              <button type="button" class="user-card secondary" onclick={() => selectUser(user)}>
                <AccountAvatar username={user.username} />
                <span class="username">{user.username}</span>
                <span class="account-arrow"><Icon name="right" size={16} /></span>
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


<style>
  .page {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: clamp(1rem, 5vw, 2.25rem);
    background: radial-gradient(ellipse at 50% 32%, var(--color-background-mute), transparent 67%),
      var(--color-background);
  }
  .auth-card {
    width: min(100%, 28rem);
    padding: clamp(1.1rem, 5vw, 2.25rem);
    border-radius: var(--radius-window);
    box-shadow: var(--edge-light), var(--shadow-window);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: .75rem;
    margin-bottom: 1.25rem;
    padding-bottom: 1rem;
    background: var(--section-rule) 0 100% / 100% 1px no-repeat;
    font-size: 1.05rem;
    font-weight: 680;
  }
  .brand-icon {
    display: grid;
    place-items: center;
    flex: 0 0 42px;
    width: 42px;
    height: 42px;
    border: 1px solid;
    border-radius: var(--radius-field);
    color: var(--color-primary-soft);
    background: var(--surface-raised);
    border-color: var(--color-border);
    box-shadow: var(--control-shadow);
  }
  .auth-flow, .user-grid { display: grid; }
  .auth-flow { gap: .9rem; }
  .user-grid { gap: .55rem; }
  .auth-flow h1 {
    font-size: clamp(1.4rem, 5vw, 1.9rem);
    font-weight: 705;
    line-height: 1.2;
    letter-spacing: -.035em;
    overflow-wrap: anywhere;
  }
  .user-card, .sign-in-heading { display: flex; align-items: center; gap: .75rem; min-width: 0; }
  .user-card { padding: .55rem .75rem .55rem .6rem; text-align: start; }
  .username { flex: 1; min-width: 0; font-size: .95rem; overflow-wrap: anywhere; }
  .account-arrow { display: flex; flex: none; color: var(--color-text-dim); }
  .user-card:is(:hover, :focus-visible) { border-color: var(--accent-border); }
  .user-card:is(:hover, :focus-visible) .account-arrow { color: var(--color-primary-soft); }
  .auth-flow > .primary { min-height: 2.65rem; }
  .back-btn { display: flex; align-items: center; gap: .35rem; justify-self: start; padding: .2rem 0;
    background: transparent; border-color: transparent; box-shadow: none; color: var(--color-text-soft); }
  .back-btn:hover { background: transparent; color: var(--color-primary-soft); }
  .error { padding: .55rem .65rem; background: #67383655; border: 1px solid #9a414580;
    color: var(--color-danger-soft); border-radius: var(--radius-field); font-size: .85rem; }
</style>
