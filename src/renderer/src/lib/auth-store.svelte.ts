import type { AuthResponse } from '../../../shared/types'

class AuthStore {
    isAuthenticated = $state(false)
    token = $state(localStorage.getItem('auth_token') || '')
    needsSetup = $state(false)
    allowUnauthenticated = $state(false)
    isChecking = $state(true)

    constructor() {
        this.checkAuth()
    }

    async checkAuth() {
        this.isChecking = true
        try {
            const response = await fetch('/api/check-auth', {
                headers: this.token ? { 'Authorization': `Bearer ${this.token}` } : {}
            })
            if (response.ok) {
                const data: AuthResponse = await response.json()
                this.needsSetup = data.needsSetup
                this.allowUnauthenticated = data.allowUnauthenticated
                this.isAuthenticated = data.authenticated
                if (!data.authenticated) {
                    this.token = ''
                    localStorage.removeItem('auth_token')
                }
            } else if (response.status === 401) {
                this.isAuthenticated = false
                this.token = ''
                localStorage.removeItem('auth_token')
            }
        } catch (error) {
            console.error('Failed to check auth:', error)
        } finally {
            this.isChecking = false
        }
    }

    async login(password: string) {
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            })
            if (response.ok) {
                const data = await response.json()
                this.token = data.token
                localStorage.setItem('auth_token', data.token)
                this.isAuthenticated = true
                return { success: true }
            } else {
                const data = await response.json()
                return { success: false, message: data.message }
            }
        } catch (error) {
            return { success: false, message: 'Network error' }
        }
    }

    async setupAdmin(password?: string, unauthenticated?: boolean) {
        try {
            const response = await fetch('/api/setup-admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, unauthenticated })
            })
            if (response.ok) {
                const data = await response.json()
                if (data.token) {
                    this.token = data.token
                    localStorage.setItem('auth_token', data.token)
                }
                this.needsSetup = false
                this.allowUnauthenticated = !!data.allowUnauthenticated
                this.isAuthenticated = true
                return { success: true }
            } else {
                const data = await response.json()
                return { success: false, message: data.message }
            }
        } catch (error) {
            return { success: false, message: 'Network error' }
        }
    }

    logout() {
        this.token = ''
        localStorage.removeItem('auth_token')
        this.isAuthenticated = false
        // We might want to notify the server but optional for now
    }
}

export const authStore = new AuthStore()
