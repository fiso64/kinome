<script lang="ts">
  import { onMount } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import AccountFilterModal from './AccountFilterModal.svelte'
  import { api } from '@lib/api'
  import { authStore } from '@lib/auth-store.svelte'
  import type { Account, AccountRole, AccountFilterRule } from '@shared/types'

  let {
    account,
    isSelf = false,
    onClose,
    onSaved
  }: {
    account: Account
    isSelf?: boolean
    onClose: () => void
    onSaved: () => void
  } = $props()

  let selectedRole = $state<AccountRole>(account.role)
  let newPassword = $state('')
  let confirmPassword = $state('')
  let passwordMessage = $state({ text: '', type: '' })
  let roleMessage = $state({ text: '', type: '' })
  let saving = $state(false)

  let filterRule = $state<AccountFilterRule | null>(null)
  let filterLoaded = $state(false)
  let showFilterModal = $state(false)

  const canManage = $derived(authStore.can.manageAccounts)
  const isAdmin = $derived(selectedRole === 'admin')

  onMount(async () => {
    if (!canManage || isSelf) return
    const result = await api.getAccountFilter(account.id)
    filterRule = result.rule
    filterLoaded = true
  })

  async function handleSaveRole() {
    if (selectedRole === account.role) return
    saving = true
    roleMessage = { text: '', type: '' }
    try {
      await api.updateAccountRole(account.id, selectedRole)
      roleMessage = { text: 'Role updated.', type: 'success' }
      onSaved()
    } catch (err: any) {
      roleMessage = { text: err.message || 'Failed to update role.', type: 'error' }
    } finally {
      saving = false
    }
  }

  async function handleChangePassword() {
    passwordMessage = { text: '', type: '' }
    if (!newPassword) {
      passwordMessage = { text: 'Password cannot be empty.', type: 'error' }
      return
    }
    if (newPassword !== confirmPassword) {
      passwordMessage = { text: 'Passwords do not match.', type: 'error' }
      return
    }
    saving = true
    try {
      if (isSelf) {
        await api.changePassword(newPassword)
      } else {
        await api.updateAccountPassword(account.id, newPassword)
      }
      passwordMessage = { text: 'Password updated.', type: 'success' }
      newPassword = ''
      confirmPassword = ''
    } catch (err: any) {
      passwordMessage = { text: err.message || 'Failed to update password.', type: 'error' }
    } finally {
      saving = false
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete account "${account.username}"? This cannot be undone.`)) return
    saving = true
    try {
      await api.deleteAccount(account.id)
      onSaved()
      onClose()
    } catch (err: any) {
      roleMessage = { text: err.message || 'Failed to delete account.', type: 'error' }
    } finally {
      saving = false
    }
  }
</script>

<ModalWindow title={isSelf ? 'Your Account' : 'Edit Account'} {onClose} cancelText="Close" maxWidth="480px">
  <div class="modal-body">
    <div class="account-header">
      <div class="avatar">{account.username[0].toUpperCase()}</div>
      <div class="account-meta">
        <span class="username">{account.username}</span>
        <span class="role-badge" class:admin={account.role === 'admin'}>{account.role === 'admin' ? 'Administrator' : 'Normal'}</span>
      </div>
    </div>

    {#if canManage && !isSelf}
      <div class="section">
        <h3>Role</h3>
        <div class="role-row">
          <select bind:value={selectedRole} disabled={saving}>
            <option value="admin">Administrator</option>
            <option value="normal">Normal</option>
          </select>
          <button class="secondary" onclick={handleSaveRole} disabled={saving || selectedRole === account.role}>
            Save Role
          </button>
        </div>
        {#if roleMessage.text}
          <p class="message" class:success={roleMessage.type === 'success'} class:error={roleMessage.type === 'error'}>
            {roleMessage.text}
          </p>
        {/if}
      </div>
    {/if}

    <div class="section">
      <h3>Change Password</h3>
      <div class="form-group">
        <label for="new-pw">New Password</label>
        <input type="password" id="new-pw" bind:value={newPassword} placeholder="Enter new password" disabled={saving} />
      </div>
      <div class="form-group">
        <label for="confirm-pw">Confirm Password</label>
        <input type="password" id="confirm-pw" bind:value={confirmPassword} placeholder="Confirm new password" disabled={saving}
          onkeydown={(e) => e.key === 'Enter' && handleChangePassword()} />
      </div>
      {#if passwordMessage.text}
        <p class="message" class:success={passwordMessage.type === 'success'} class:error={passwordMessage.type === 'error'}>
          {passwordMessage.text}
        </p>
      {/if}
      <button class="secondary" onclick={handleChangePassword} disabled={saving}>Update Password</button>
    </div>

    {#if canManage && !isSelf && !isAdmin && filterLoaded}
      <div class="section">
        <h3>Library Filter</h3>
        <div class="filter-row">
          <span class="filter-status">
            {#if filterRule}
              {filterRule.mode === 'allow' ? 'Allow' : 'Deny'} filter active
            {:else}
              No filter — full access
            {/if}
          </span>
          <button class="secondary" onclick={() => (showFilterModal = true)}>Configure Filter</button>
        </div>
      </div>
    {/if}

    {#if canManage && !isSelf}
      <div class="section danger-section">
        <h3>Danger Zone</h3>
        <button class="danger" onclick={handleDelete} disabled={saving}>Delete Account</button>
      </div>
    {/if}
  </div>
</ModalWindow>

{#if showFilterModal}
  <AccountFilterModal
    {account}
    onClose={() => (showFilterModal = false)}
    onSaved={async () => {
      const result = await api.getAccountFilter(account.id)
      filterRule = result.rule
    }}
  />
{/if}

<style>
  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1.5rem;
  }

  .account-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background-color: var(--color-background-soft);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background-color: var(--color-primary);
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 1.4rem;
    flex-shrink: 0;
  }

  .account-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .username {
    font-weight: 600;
    font-size: 1.05rem;
  }

  .role-badge {
    font-size: 0.8rem;
    color: var(--color-text-dim);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    width: fit-content;
  }

  .role-badge.admin {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background-color: transparent;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border-soft);
  }

  .section h3 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--color-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .role-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .role-row select {
    flex: 1;
    padding: 0.6rem 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 0.95rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .form-group label {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-text-soft);
  }

  input[type='password'] {
    padding: 0.6rem 0.75rem;
    background-color: var(--color-background-mute);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 0.95rem;
    width: 100%;
  }

  .message {
    font-size: 0.85rem;
    margin: 0;
  }

  .message.success { color: var(--color-success); }
  .message.error { color: var(--color-danger); }

  .filter-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .filter-status {
    font-size: 0.9rem;
    color: var(--color-text-soft);
  }

  .danger-section {
    border-color: rgba(239, 68, 68, 0.2);
  }

  .danger-section h3 {
    color: var(--color-danger);
  }
</style>
