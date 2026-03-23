import type { Account, Capability } from '@shared/types'

type AccountWithCaps = Account & { capabilities: Capability[] }

class AuthStore {
  isAuthenticated = $state(false)
  token = $state(localStorage.getItem('auth_token') || '')
  needsSetup = $state(false)
  isChecking = $state(true)
  account = $state<AccountWithCaps | null>(null)

  get can() {
    const caps = new Set(this.account?.capabilities ?? [])
    return {
      editMetadata: caps.has('editMetadata'),
      editSettings: caps.has('editSettings'),
      manageAccounts: caps.has('manageAccounts'),
      triggerLibraryScan: caps.has('triggerLibraryScan'),
    }
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
    this.token = ''
    localStorage.removeItem('auth_token')
    this.isAuthenticated = false
    this.account = null
  }
}

export const authStore = new AuthStore()
