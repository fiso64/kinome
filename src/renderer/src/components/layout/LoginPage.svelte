<script lang="ts">
  import { authStore } from '@lib/auth-store.svelte'
  import { onMount } from 'svelte'
  import { fade, fly } from 'svelte/transition'

  type UserEntry = { id: string; username: string }

  let users = $state<UserEntry[]>([])
  let selectedUser = $state<UserEntry | null>(null)
  let password = $state('')
  let error = $state('')
  let loading = $state(false)

  // Setup mode state
  let setupMode = $state(false)
  let setupUsername = $state('')
  let setupPassword = $state('')
  let setupToken = $state('')

  onMount(async () => {
    if (authStore.needsSetup) {
      setupMode = true
      return
    }
    const res = await fetch('/api/users')
    if (res.ok) users = await res.json()
  })

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
    if (!selectedUser) return
    loading = true
    error = ''
    const result = await authStore.login(selectedUser.username, password)
    if (!result.success) error = result.message || 'Incorrect password'
    loading = false
  }

  async function handleSetup() {
    loading = true
    error = ''
    if (!setupToken) { error = 'Setup token required'; loading = false; return }
    if (!setupUsername) { error = 'Username required'; loading = false; return }
    if (!setupPassword) { error = 'Password required'; loading = false; return }
    const result = await authStore.setupAdmin(setupToken, setupUsername, setupPassword)
    if (!result.success) error = result.message || 'Setup failed'
    loading = false
  }

  const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#0ea5e9', '#14b8a6', '#f59e0b', '#10b981']

  function avatarColor(username: string): string {
    let hash = 0
    for (const c of username) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
  }

  function passwordFocus(node: HTMLInputElement) {
    setTimeout(() => node.focus(), 50)
  }
</script>

<div class="page">
  {#if setupMode}
    <div class="setup-card" in:fade={{ duration: 200 }}>
      <div class="app-name">Kinome</div>
      <h2>Initial Setup</h2>
      <p class="setup-description">
        Enter the setup token from your server console, then create your admin account.
      </p>
      <input type="text" bind:value={setupToken} placeholder="Setup token" disabled={loading}
        onkeydown={(e) => e.key === 'Enter' && handleSetup()} />
      <input type="text" bind:value={setupUsername} placeholder="Admin username" disabled={loading || !setupToken}
        onkeydown={(e) => e.key === 'Enter' && handleSetup()} />
      <input type="password" bind:value={setupPassword} placeholder="Admin password" disabled={loading || !setupToken}
        onkeydown={(e) => e.key === 'Enter' && handleSetup()} />
      {#if error}<div class="error">{error}</div>{/if}
      <button class="primary sign-in-btn" onclick={handleSetup} disabled={loading}>
        {loading ? 'Creating...' : 'Create Account'}
      </button>
    </div>

  {:else if !selectedUser}
    <div class="picker" in:fade={{ duration: 200 }}>
      <div class="app-name">Kinome</div>
      <div class="user-grid">
        {#each users as user (user.id)}
          <button class="user-card" onclick={() => selectUser(user)}>
            <div class="avatar" style="background: {avatarColor(user.username)}">
              {user.username[0].toUpperCase()}
            </div>
            <span class="username">{user.username}</span>
          </button>
        {/each}
      </div>
    </div>

  {:else}
    <div class="signin" in:fly={{ y: 16, duration: 200 }}>
      <button class="back-btn" onclick={back}>← Back</button>
      <div class="avatar large" style="background: {avatarColor(selectedUser.username)}">
        {selectedUser.username[0].toUpperCase()}
      </div>
      <div class="signing-in-as">{selectedUser.username}</div>
      <input
        type="password"
        bind:value={password}
        placeholder="Password"
        disabled={loading}
        use:passwordFocus
        onkeydown={(e) => e.key === 'Enter' && handleLogin()}
      />
      {#if error}<div class="error">{error}</div>{/if}
      <button class="primary sign-in-btn" onclick={handleLogin} disabled={loading || !password}>
        {loading ? 'Signing in...' : 'Sign In'}
      </button>
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    background: var(--color-background);
  }

  .app-name {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-primary-soft);
    letter-spacing: 0.05em;
    margin-bottom: 2.5rem;
    text-align: center;
  }

  /* ── Profile Picker ──────────────────────────────── */

  .picker {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .user-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    justify-content: center;
    max-width: 600px;
  }

  .user-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    background: none;
    padding: 1rem;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    width: 110px;
  }

  .user-card:hover {
    background: var(--color-background-soft);
    transform: translateY(-3px);
  }

  .avatar {
    width: 80px;
    height: 80px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  .avatar.large {
    width: 96px;
    height: 96px;
    font-size: 2.5rem;
    border-radius: 8px;
  }

  .username {
    font-size: 0.9rem;
    color: var(--color-text-soft);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  /* ── Sign In ─────────────────────────────────────── */

  .signin {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 300px;
    position: relative;
    padding-top: 2rem;
  }

  .back-btn {
    position: absolute;
    top: -1rem;
    left: 0;
    background: none;
    color: var(--color-text-soft);
    font-size: 0.85rem;
    padding: 0.25rem 0.5rem;
  }

  .back-btn:hover {
    color: var(--color-text);
    background: none;
  }

  .signing-in-as {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 0.25rem;
  }

  .signin input {
    width: 100%;
    padding: 0.75rem 1rem;
    font-size: 0.95rem;
  }

  .sign-in-btn {
    width: 100%;
    padding: 0.75rem;
    font-size: 0.95rem;
  }

  /* ── Setup ───────────────────────────────────────── */

  .setup-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 340px;
  }

  .setup-card h2 {
    font-size: 1.1rem;
    font-weight: 600;
    text-align: center;
    margin-bottom: 0.25rem;
  }

  .setup-description {
    font-size: 0.85rem;
    color: var(--color-text-soft);
    text-align: center;
    margin-bottom: 0.5rem;
    line-height: 1.5;
  }

  .setup-card input {
    width: 100%;
    padding: 0.75rem 1rem;
    font-size: 0.95rem;
  }

  /* ── Shared ──────────────────────────────────────── */

  .error {
    width: 100%;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: var(--color-danger);
    padding: 0.6rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    text-align: center;
  }
</style>
