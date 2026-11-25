import type { Account, Capability } from '@shared/types'

const CAPABILITY_TITLES: Record<Capability, string> = {
  editMetadata: 'Requires permission to edit the library',
  editSettings: 'Requires permission to change server settings',
  manageAccounts: 'Requires permission to manage accounts',
  triggerLibraryScan: 'Requires permission to scan the library'
}

type AccountWithCaps = Account & { capabilities: Capability[] }

class AuthStore {
  isAuthenticated = $state(false)
  token = $state(localStorage.getItem('auth_token') || '')
  needsSetup = $state(false)
  isChecking = $state(true)
  account = $state<AccountWithCaps | null>(null)

  get can(): Record<Capability, boolean> {
    const caps = this.account?.capabilities ?? []
    return {
      editMetadata: caps.includes('editMetadata'),
      editSettings: caps.includes('editSettings'),
      manageAccounts: caps.includes('manageAccounts'),
      triggerLibraryScan: caps.includes('triggerLibraryScan'),
    }
  }

  control(capability: Capability, title?: string): { disabled: boolean; title: string | undefined } {
    const disabled = !this.account?.capabilities.includes(capability)
    return { disabled, title: disabled ? CAPABILITY_TITLES[capability] : title }
  }

  updatePermissions({ role, capabilities }: Pick<AccountWithCaps, 'role' | 'capabilities'>) {
    const account = this.account
    if (!account || (account.role === role && account.capabilities.length === capabilities.length &&
      account.capabilities.every((capability) => capabilities.includes(capability)))) return
    this.account = { ...account, role, capabilities }
  }

  constructor() {
    this.checkAuth()
  }

  async checkAuth() {
    this.isChecking = true
    try {
      const response = await fetch('/api/check-auth', {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}
      })
      if (response.ok) {
        const data = await response.json()
        this.needsSetup = data.needsSetup ?? false
        this.isAuthenticated = data.authenticated ?? false
        this.account = data.account ?? null
        if (!data.authenticated) {
          this.token = ''
          localStorage.removeItem('auth_token')
        }
      } else if (response.status === 401) {
        this.isAuthenticated = false
        this.account = null
        this.token = ''
        localStorage.removeItem('auth_token')
      }
    } catch (error) {
      console.error('Failed to check auth:', error)
    } finally {
      this.isChecking = false
    }
  }

  async login(username: string, password: string) {
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      const data = await response.json()
      if (data.authenticated && data.token) {
        this.token = data.token
        localStorage.setItem('auth_token', data.token)
        this.isAuthenticated = true
        this.account = data.account ?? null
        return { success: true }
      } else {
        this.isAuthenticated = false
        this.account = null
        this.token = ''
        localStorage.removeItem('auth_token')
        return { success: false, message: data.message || 'Login failed' }
      }
    } catch (error) {
      return { success: false, message: 'Network error' }
    }
  }

  async setupAdmin(setupToken: string, username: string, password: string) {
    try {
      const response = await fetch('/api/setup-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken, username, password })
      })
      const data = await response.json()
      if (data.authenticated && data.token) {
        this.token = data.token
        localStorage.setItem('auth_token', data.token)
        this.needsSetup = false
        this.isAuthenticated = true
        this.account = data.account ?? null
        return { success: true }
      } else {
        return { success: false, message: data.message || 'Setup failed' }
      }
    } catch (error) {
      return { success: false, message: 'Network error' }
    }
  }

  logout() {
    // Sessions persist on the server until they are signed out.
    if (this.token) {
      void fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } }).catch(() => {})
    }
    this.token = ''
    localStorage.removeItem('auth_token')
    this.isAuthenticated = false
    this.account = null
  }
}

export const authStore = new AuthStore()
