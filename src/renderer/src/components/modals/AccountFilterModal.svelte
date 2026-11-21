<script lang="ts">
  import { onMount } from 'svelte'
  import ModalWindow from './_base/ModalWindow.svelte'
  import FilterEditor from './_parts/FilterEditor.svelte'
  import { api } from '@lib/api'
  import type { Account, AccountFilterRule, LibraryCondition, AutocompleteSuggestions } from '@shared/types'

  let {
    account,
    onClose,
    onSaved
  }: {
    account: Account
    onClose: () => void
    onSaved: () => void
  } = $props()

  let filterRule = $state<AccountFilterRule | null>(null)
  let filterMode = $state<'allow' | 'deny'>('allow')
  let filterGroups = $state<LibraryCondition[][]>([[]])
  let message = $state({ text: '', type: '' })
  let saving = $state(false)
  let suggestions = $state<AutocompleteSuggestions>({ mediaType: [], genre: [], person: null, tags: {}, virtualTags: {} })

  onMount(async () => {
    const [filterResult, suggResult] = await Promise.all([
      api.getAccountFilter(account.id),
      api.getAutocompleteSuggestions()
    ])
    suggestions = suggResult
    filterRule = filterResult.rule
    if (filterRule) {
      filterMode = filterRule.mode
      filterGroups =
        filterRule.filter.conditionGroups ??
        (filterRule.filter.conditions ? [filterRule.filter.conditions] : [[]])
    }
  })

  async function handleSave() {
    saving = true
    message = { text: '', type: '' }
    try {
      const filter = { conditionGroups: filterGroups }
      await api.setAccountFilter(account.id, filterMode, filter)
      filterRule = { accountId: account.id, mode: filterMode, filter }
      message = { text: 'Filter saved and applied.', type: 'success' }
      onSaved()
    } catch (err: any) {
      message = { text: err.message || 'Failed to save filter.', type: 'error' }
    } finally {
      saving = false
    }
  }

  async function handleClear() {
    saving = true
    message = { text: '', type: '' }
    try {
      await api.deleteAccountFilter(account.id)
      filterRule = null
      filterGroups = [[]]
      message = { text: 'Filter removed. Full access restored.', type: 'success' }
      onSaved()
    } catch (err: any) {
      message = { text: err.message || 'Failed to remove filter.', type: 'error' }
    } finally {
      saving = false
    }
  }
</script>

<ModalWindow
  title="Library Filter - {account.username}"
  {onClose}
  maxWidth="600px"
>
  <div class="form-stack">
    <p class="description">
      Restrict which library items this account can see. Leave conditions empty for full access.
    </p>

    <div class="choice-grid">
      <label class="choice-card">
        <input type="radio" bind:group={filterMode} value="allow" disabled={saving} />
        <span><strong>Allow matches</strong><span class="form-hint">Includes their contents and parent folders.</span></span>
      </label>
      <label class="choice-card">
        <input type="radio" bind:group={filterMode} value="deny" disabled={saving} />
        <span><strong>Deny matches</strong><span class="form-hint">Also hides their contents.</span></span>
      </label>
    </div>

    {#if filterMode === 'allow'}
      <p class="description">
        Children inherit access from matching condition groups. A conflicting tag stops inheritance
        for that group. A direct match in another OR group can keep the branch visible.
      </p>
    {/if}

    <FilterEditor bind:groups={filterGroups} {suggestions} />

    {#if message.text}
      <p class="message" class:success={message.type === 'success'} class:error={message.type === 'error'}>
        {message.text}
      </p>
    {/if}

  </div>
  {#snippet actions()}
    {#if filterRule}
      <button class="danger" onclick={handleClear} disabled={saving}>Remove filter</button>
    {/if}
    <button class="secondary" onclick={onClose}>Close</button>
    <button class="primary" onclick={handleSave} disabled={saving}>Save filter</button>
  {/snippet}
</ModalWindow>

<style>
  .description, .message { font-size: .855rem; color: var(--color-text-soft); }
  .message.success { color: var(--color-success-soft); }
  .message.error { color: var(--color-danger-soft); }
</style>
