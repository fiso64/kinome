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
  let savedRole = $state<AccountRole>(account.role)
  let newPassword = $state('')
  let confirmPassword = $state('')
  let passwordMessage = $state({ text: '', type: '' })
  let roleMessage = $state({ text: '', type: '' })
  let saving = $state(false)

  let filterRule = $state<AccountFilterRule | null>(null)
  let filterLoaded = $state(false)
  let showFilterModal = $state(false)

  const canManage = $derived(authStore.can.manageAccounts)
  const isAdmin = $derived(savedRole === 'admin')

  onMount(async () => {
    if (!canManage || isSelf) return
    const result = await api.getAccountFilter(account.id)
    filterRule = result.rule
    filterLoaded = true
  })

  async function handleSaveRole() {
    if (!canManage || isSelf || selectedRole === savedRole) return
    saving = true
    roleMessage = { text: '', type: '' }
    try {
      await api.updateAccountRole(account.id, selectedRole)
      savedRole = selectedRole
      if (savedRole === 'admin') filterRule = null
      roleMessage = { text: 'Role updated.', type: 'success' }
      onSaved()
    } catch (err: any) {
      roleMessage = { text: err.message || 'Failed to update role.', type: 'error' }
    } finally {
      saving = false
    }
  }

  async function handleChangePassword() {
    if (!isSelf && !canManage) return
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
  <div class="form-stack">
    <div class="account-header raised-surface">
      <div class="avatar">{account.username[0].toUpperCase()}</div>
      <div class="account-meta">
        <span class="username">{account.username}</span>
        <span class="role-badge" class:admin={isAdmin}>{isAdmin ? 'Administrator' : 'Normal'}</span>
      </div>
    </div>

    {#if canManage && !isSelf}
      <div class="section raised-surface">
        <h3>Role</h3>
        <div class="role-row">
          <select aria-label="Account role" bind:value={selectedRole} disabled={saving}>
            <option value="admin">Administrator</option>
            <option value="normal">Normal</option>
          </select>
          <button class="secondary" onclick={handleSaveRole} disabled={saving || selectedRole === savedRole}>
            Update Role
          </button>
        </div>
        {#if roleMessage.text}
          <p class="message" role="status" class:success={roleMessage.type === 'success'} class:error={roleMessage.type === 'error'}>
            {roleMessage.text}
          </p>
        {/if}
      </div>
    {/if}

    <div class="section raised-surface">
      <h3>Change Password</h3>
      <div class="form-field">
        <label for="new-pw">New Password</label>
        <input type="password" autocomplete="new-password" id="new-pw" bind:value={newPassword} placeholder="Enter new password" disabled={saving} />
      </div>
      <div class="form-field">
        <label for="confirm-pw">Confirm Password</label>
        <input type="password" autocomplete="new-password" id="confirm-pw" bind:value={confirmPassword} placeholder="Confirm new password" disabled={saving}
          onkeydown={(e) => e.key === 'Enter' && handleChangePassword()} />
      </div>
      {#if passwordMessage.text}
        <p class="message" role="status" class:success={passwordMessage.type === 'success'} class:error={passwordMessage.type === 'error'}>
          {passwordMessage.text}
        </p>
      {/if}
      <button class="secondary" onclick={handleChangePassword} disabled={saving}>Update Password</button>
    </div>

    {#if canManage && !isSelf && filterLoaded}
      <div class="section raised-surface">
        <h3>Library Filter</h3>
        <div class="filter-row">
          <span class="filter-status">
            {#if isAdmin}
              Administrators have full access
            {:else if filterRule}
              {filterRule.mode === 'allow' ? 'Allow' : 'Deny'} filter active
            {:else}
              No filter - full access
            {/if}
          </span>
          <button class="secondary" disabled={isAdmin || saving} title={isAdmin ? 'Library filters apply to regular accounts' : undefined}
            onclick={() => (showFilterModal = true)}>Configure Filter</button>
        </div>
      </div>
    {/if}

    {#if canManage && !isSelf}
      <div class="section danger-section raised-surface">
        <h3>Remove account</h3>
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
  .account-header, .role-row, .filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem; }
  .account-header { padding: .7rem; }
  .avatar { display: grid; place-items: center; flex: 0 0 42px; height: 42px; border-radius: var(--radius-field);
    color: var(--color-primary-soft); border: 1px solid var(--accent-border); background: var(--accent-surface); font-size: 1.2rem; font-weight: 690; }
  .account-meta, .section { display: grid; min-width: 0; gap: .5rem; }
  .account-meta { gap: .1rem; }
  .username { font-weight: 670; overflow-wrap: anywhere; }
  .role-badge, .filter-status, .message { color: var(--color-text-soft); font-size: .82rem; }
  .role-badge.admin { color: var(--color-primary-soft); }
  .section { padding: .75rem; }
  .section h3 { font-size: .95rem; font-weight: 660; }
  .role-row select { flex: 1; }
  .section > button { justify-self: start; }
  .message.success { color: var(--color-success-soft); }
  .message.error, .danger-section h3 { color: var(--color-danger-soft); }
  .filter-row { justify-content: space-between; }
  .danger-section { border-color: #7a4345; }
</style>
