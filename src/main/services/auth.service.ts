import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import * as settingsService from './settings.service'
import type { AuthResponse } from '@shared/types'

// Simple in-memory session management
const sessions = new Set<string>()

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, 10)
}

export async function validatePassword(password: string): Promise<boolean> {
  const settings = await settingsService.readSettings()
  if (!settings.adminPasswordHash) {
    return false
  }
  return await bcrypt.compare(password, settings.adminPasswordHash)
}

export async function login(password: string): Promise<string | null> {
  if (await validatePassword(password)) {
    const token = crypto.randomUUID()
    sessions.add(token)
    return token
  }
  return null
}

export function validateToken(token: string): boolean {
  return sessions.has(token)
}

export function logout(token: string): void {
  sessions.delete(token)
}

export async function getAuthState(): Promise<AuthResponse> {
  const settings = await settingsService.readSettings()

  // needsSetup is true ONLY if NO password hash is set AND unauthenticated access is NOT enabled.
  // However, if we HAVE a library location, we should definitely have a password or have explicitly allowed unauthenticated access.
  const hasHash = !!settings.adminPasswordHash
  const allowUnauth = !!settings.allowUnauthenticated
  const needsSetup = !hasHash && !allowUnauth

  console.log(
    `[AuthState] hash=${hasHash}, allowUnauth=${allowUnauth}, needsSetup=${needsSetup}, libLoc=${!!settings.libraryLocation}`
  )

  return {
    success: true,
    isAdmin: true, // Only one user for now
    needsSetup,
    allowUnauthenticated: allowUnauth,
    authenticated: allowUnauth
  }
}

export async function setupAdmin(
  password?: string,
  unauthenticated?: boolean
): Promise<AuthResponse> {
  if (unauthenticated) {
    await settingsService.writeGlobalSettings({ allowUnauthenticated: true })
    return {
      success: true,
      isAdmin: true,
      needsSetup: false,
      allowUnauthenticated: true,
      authenticated: true
    }
  }

  if (password) {
    const hash = await hashPassword(password)
    await settingsService.writeGlobalSettings({
      adminPasswordHash: hash,
      allowUnauthenticated: false
    })
    const token = crypto.randomUUID()
    sessions.add(token)
    return {
      success: true,
      token,
      isAdmin: true,
      needsSetup: false,
      allowUnauthenticated: false,
      authenticated: true
    }
  }

  throw new Error('Either password or unauthenticated option must be provided.')
}

export async function updateAdminPassword(password: string): Promise<void> {
  const hash = await hashPassword(password)
  await settingsService.writeGlobalSettings({ adminPasswordHash: hash })
  sessions.clear() // Invalidate all active sessions
}
