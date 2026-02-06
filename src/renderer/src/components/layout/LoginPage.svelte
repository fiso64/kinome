<script lang="ts">
  import { authStore } from '@lib/auth-store.svelte'
  import { onMount } from 'svelte'

  let password = $state('')
  let error = $state('')
  let loading = $state(false)
  let setupMode = $state(false)
  let allowUnauthenticated = $state(false)

  onMount(() => {
    if (authStore.needsSetup) {
      setupMode = true
    }
  })

  async function handleLogin() {
    loading = true
    error = ''
    const result = await authStore.login(password)
    if (!result.success) {
      error = result.message || 'Login failed'
    }
    loading = false
  }

  async function handleSetup() {
    loading = true
    error = ''
    if (!allowUnauthenticated && !password) {
      error = 'Please provide a password or select unauthenticated access.'
      loading = false
      return
    }
    const result = await authStore.setupAdmin(password, allowUnauthenticated)
    if (!result.success) {
      error = result.message || 'Setup failed'
    }
    loading = false
  }

  function focus(node: HTMLElement) {
    node.focus()
  }
</script>

<div class="login-wrapper">
  <div class="login-card">
    <div class="header">
      <span class="logo-icon">🎬</span>
      <h1>Media Browser</h1>
    </div>

    {#if setupMode}
      <div class="view-content">
        <h2>Initial Setup</h2>
        <p class="description">
          Secure your server with a password or allow unauthenticated access.
        </p>

        <div class="setup-options">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={allowUnauthenticated} />
            <span>Allow unauthenticated access</span>
          </label>
          <p class="hint">Not recommended if your server is accessible over the internet.</p>
        </div>

        {#if !allowUnauthenticated}
          <div class="input-group">
            <input
              type="password"
              bind:value={password}
              placeholder="Set Admin Password"
              disabled={loading}
              use:focus
              onkeydown={(e) => e.key === 'Enter' && handleSetup()}
            />
          </div>
        {/if}

        {#if error}
          <div class="error-banner">{error}</div>
        {/if}

        <div class="actions">
          <button class="primary" onclick={handleSetup} disabled={loading}>
            {loading ? 'Setting up...' : 'Complete Setup'}
          </button>
        </div>
      </div>
    {:else}
      <div class="view-content">
        <h2>Server Login</h2>
        <p class="description">Enter your admin password to continue.</p>

        <div class="input-group">
          <input
            type="password"
            bind:value={password}
            placeholder="Admin Password"
            disabled={loading}
            use:focus
            onkeydown={(e) => e.key === 'Enter' && handleLogin()}
          />
        </div>

        {#if error}
          <div class="error-banner">{error}</div>
        {/if}

        <div class="actions">
          <button class="primary" onclick={handleLogin} disabled={loading}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .login-wrapper {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    background-color: var(--color-background);
    color: var(--ev-c-text-1);
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-background-mute);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }

  .header {
    padding: 2rem 2rem 1rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .logo-icon {
    font-size: 2rem;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
  }

  .view-content {
    padding: 0 2rem 2rem;
  }

  h2 {
    font-size: 1rem;
    color: var(--ev-c-text-1);
    margin-bottom: 0.5rem;
  }

  .description {
    font-size: 0.85rem;
    color: var(--ev-c-text-2);
    margin-bottom: 2rem;
    line-height: 1.4;
  }

  .input-group {
    margin-bottom: 1.5rem;
  }

  input[type='password'] {
    width: 100%;
    padding: 0.75rem 1rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-background-mute);
    border-radius: 4px;
    color: var(--ev-c-text-1);
    font-size: 0.95rem;
    transition: border-color 0.2s;
  }

  input[type='password']:focus {
    border-color: var(--ev-c-gray-1);
    outline: none;
  }

  .setup-options {
    margin-bottom: 1.5rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    cursor: pointer;
    font-size: 0.9rem;
    color: var(--ev-c-text-1);
  }

  .checkbox-label input {
    width: 1rem;
    height: 1rem;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--ev-c-text-3);
    margin-top: 0.5rem;
    padding-left: 1.75rem;
  }

  .error-banner {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: #ef4444;
    padding: 0.75rem;
    border-radius: 4px;
    margin-bottom: 1.5rem;
    font-size: 0.85rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  button.primary {
    background-color: var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
    padding: 0.6rem 2rem;
    border-radius: 4px;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  button.primary:hover:not(:disabled) {
    background-color: var(--ev-c-gray-1);
  }

  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
