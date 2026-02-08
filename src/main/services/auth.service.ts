import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import fs from 'fs/promises'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import * as settingsService from './settings.service'
import { getUserDataPath } from './paths.service'
import type { AuthResponse } from '@shared/types'

// Simple in-memory session management
const sessions = new Set<string>()

function getSetupTokenPath(): string {
  return path.join(getUserDataPath(), 'setup-token.txt')
}

/**
 * Ensures a setup token exists if no admin password is set.
 * Returns the token if it exists/was created, null otherwise.
 */
export function ensureSetupToken(): string | null {
  const tokenPath = getSetupTokenPath()

  // If we already have a password, we don't need a token
  // Use readFileSync here because this is called during the synchronous startup sequence
  const settingsFile = path.join(getUserDataPath(), 'settings.json')
  if (existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'))
      if (settings.server?.adminPasswordHash || settings.adminPasswordHash) {
        if (existsSync(tokenPath)) unlinkSync(tokenPath)
        return null
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  const token = existsSync(tokenPath)
    ? readFileSync(tokenPath, 'utf-8').trim()
    : Math.floor(10000000 + Math.random() * 90000000).toString()

  if (!existsSync(tokenPath)) {
    writeFileSync(tokenPath, token, 'utf-8')
  }

  console.log('*****************************************************')
  console.log('*                                                   *')
  console.log('*       KINOME INITIAL SETUP TOKEN REQUIRED         *')
  console.log(`*               TOKEN: ${token}                     *`)
  console.log('*                                                   *')
  console.log('*  Find this token in:                              *')
  console.log(`*  ${tokenPath}   *`)
  console.log('*                                                   *')
  console.log('*****************************************************')

  return token
}

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
  unauthenticated?: boolean,
  setupToken?: string
): Promise<AuthResponse> {
  const settings = await settingsService.readSettings()
  if (settings.adminPasswordHash || settings.allowUnauthenticated) {
    throw new Error('Server already set up.')
  }

  const tokenPath = getSetupTokenPath()
  if (existsSync(tokenPath)) {
    const validToken = (await fs.readFile(tokenPath, 'utf-8')).trim()
    if (setupToken !== validToken) {
      throw new Error('Invalid setup token.')
    }
  } else {
    // If there is no token file but we are in setup mode, it's a weird state.
    // However, if we're on localhost we might want to allow it? No, let's stay strict.
    throw new Error('Setup token file missing. Restart the server to regenerate.')
  }

  if (unauthenticated) {
    await settingsService.writeGlobalSettings({ allowUnauthenticated: true })
    if (existsSync(tokenPath)) await fs.unlink(tokenPath)
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
    if (existsSync(tokenPath)) await fs.unlink(tokenPath)
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
