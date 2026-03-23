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
  title="Library Filter — {account.username}"
  {onClose}
  cancelText="Close"
  maxWidth="600px"
>
  <div class="content">
    <p class="description">
      Restrict which library items this account can see. Leave conditions empty for full access.
    </p>

    <div class="mode-row">
      <label>
        <input type="radio" bind:group={filterMode} value="allow" disabled={saving} />
        Allow only matching items (+ their contents and parent folders)
      </label>
      <label>
        <input type="radio" bind:group={filterMode} value="deny" disabled={saving} />
        Deny matching items (+ their contents)
      </label>
    </div>

    <FilterEditor bind:groups={filterGroups} {suggestions} />

    {#if message.text}
      <p class="message" class:success={message.type === 'success'} class:error={message.type === 'error'}>
        {message.text}
      </p>
    {/if}

    <div class="buttons">
      <button class="secondary" onclick={handleSave} disabled={saving}>Save Filter</button>
      {#if filterRule}
        <button class="secondary" onclick={handleClear} disabled={saving}>Remove Filter</button>
      {/if}
    </div>
  </div>
</ModalWindow>

<style>
  .content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.5rem;
  }

  .description {
    font-size: 0.85rem;
    color: var(--color-text-soft);
    margin: 0;
    line-height: 1.5;
  }

  .mode-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.9rem;
    color: var(--color-text-soft);
  }

  .mode-row label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .message {
    font-size: 0.85rem;
    margin: 0;
  }

  .message.success { color: var(--color-success); }
  .message.error { color: var(--color-danger); }

  .buttons {
    display: flex;
    gap: 0.75rem;
  }
</style>
