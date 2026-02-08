<script lang="ts">
  import { authStore } from '@lib/auth-store.svelte'
  import { onMount } from 'svelte'

  let password = $state('')
  let error = $state('')
  let loading = $state(false)
  let setupMode = $state(false)
  let setupToken = $state('')
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
    if (!password) {
      error = 'Please provide an admin password.'
      loading = false
      return
    }
    if (!setupToken) {
      error = 'Please provide the setup token from your server console.'
      loading = false
      return
    }
    const result = await authStore.setupAdmin(password, allowUnauthenticated, setupToken)
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
      <h1>Kinome</h1>
    </div>

    {#if setupMode}
      <div class="view-content">
        <h2>Initial Setup</h2>
        <p class="description">
          Secure your server with a password.
          <br /><br />
          <strong>Proof of Access required:</strong> To complete setup, enter the 8-digit token
          found in the server terminal or in your <code>setup-token.txt</code> file.
        </p>

        <div class="input-group">
          <input
            type="text"
            bind:value={setupToken}
            placeholder="8-Digit Setup Token"
            disabled={loading}
            onkeydown={(e) => e.key === 'Enter' && handleSetup()}
          />
        </div>

        <div class="input-group">
          <input
            type="password"
            bind:value={password}
            placeholder="Set Admin Password"
            disabled={loading || !setupToken}
            use:focus
            onkeydown={(e) => e.key === 'Enter' && handleSetup()}
          />
        </div>

        {#if error}
          <div class="error-banner">{error}</div>
        {/if}

        <div class="actions">
          <button class="primary" onclick={handleSetup} disabled={loading}>
            {loading ? 'Setting up...' : 'Set Password'}
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
    color: var(--color-text);
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-standard);
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
    color: var(--color-text);
    margin-bottom: 0.5rem;
  }

  .description {
    font-size: 0.85rem;
    color: var(--color-text-soft);
    margin-bottom: 2rem;
    line-height: 1.4;
  }

  .input-group {
    margin-bottom: 1.5rem;
  }

  input[type='password'],
  input[type='text'] {
    width: 100%;
    padding: 0.75rem 1rem;
    background-color: var(--color-background);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-size: 0.95rem;
    transition: border-color 0.2s;
  }

  input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background-color: var(--color-background-soft);
  }

  input[type='password']:focus,
  input[type='text']:focus {
    border-color: var(--ev-c-gray-1);
    outline: none;
  }

  .error-banner {
    background-color: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    color: var(--color-danger);
    padding: 0.75rem;
    border-radius: 4px;
    margin-bottom: 1.5rem;
    font-size: 0.85rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  /* Note: button styles are inherited from base.css */
</style>
