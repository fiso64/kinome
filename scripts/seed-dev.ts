/**
 * Resets the dev database and seeds two test accounts.
 * Always deletes library.db first — use via `bun dev:fresh`.
 */
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcryptjs'
import { initializeStartup } from '../src/main/services/startup.service'
import { initializeDatabase } from '../src/main/database/client'
import { resolveLibraryPath } from '../src/main/services/paths.service'
import * as accountRepo from '../src/main/database/repositories/account.repo'

function resolveUserDataPath(): string {
  const appName = 'kinome'
  if (process.env.KINOME_DATA) return process.env.KINOME_DATA
  const localDataPath = path.resolve(process.cwd(), 'data')
  if (fs.existsSync(localDataPath)) return localDataPath
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', appName)
  if (process.platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', appName)
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')
  return path.join(xdgConfig, appName)
}

const userDataPath = resolveUserDataPath()
fs.mkdirSync(userDataPath, { recursive: true })

// Initialize paths first so resolveLibraryPath reflects any custom library location in settings.json
initializeStartup(userDataPath)

const dbPath = resolveLibraryPath('library.db')
if (dbPath && fs.existsSync(dbPath)) {
  fs.rmSync(dbPath)
  console.log(`Deleted ${dbPath}`)
}

initializeDatabase()

const hash = await bcrypt.hash('q', 4)
accountRepo.createAccount('admin', 'admin', hash, 'admin')
accountRepo.createAccount('user', 'user', hash, 'normal')

console.log('Done: admin/q (admin), user/q (normal)')

// Create test library structure if it doesn't exist
const testLibRoot = path.resolve(process.cwd(), 'test-data/test-lib-small')
if (!fs.existsSync(testLibRoot)) {
  const files = [
    '.library/',
    'Breaking Bad/Extras/file.mkv',
    'Breaking Bad/S01/e01.mkv',
    'Breaking Bad/S01/e02.mkv',
    'Breaking Bad/S01/e03.mkv',
    'Breaking Bad/S02/e01.mkv',
    'Breaking Bad/S02/e02.mkv',
    'Breaking Bad/S02/e03.mkv',
    'Breaking Bad/file.mkv',
    'Death Note/Extras/file.mkv',
    'Death Note/Other Folder/file.mkv',
    'Death Note/e01.mkv',
    'Death Note/e02.mkv',
    'Death Note/e03.mkv',
    'Death Note/ending-not-an-episode.mkv',
    'Death Note/not-an-episode.srt',
    'Spirited Away/movie.mkv',
    'The Godfather/godfather.mkv',
  ]
  for (const entry of files) {
    const full = path.join(testLibRoot, entry)
    if (entry.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, '')
    }
  }
  console.log(`Created test library structure at ${testLibRoot}`)
}
