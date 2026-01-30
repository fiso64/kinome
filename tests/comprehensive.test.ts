import { test, describe, before, after } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'

// --- Configuration ---
const PORT = 3003 // Use different port than basic test
const BASE_URL = `http://localhost:${PORT}/api/v2`
// We need a separate test data folder
const TEST_ROOT = path.join(process.cwd(), 'test_comprehensive')
const USER_DATA_PATH = path.join(TEST_ROOT, 'user_data')
const LIBRARY_PATH = path.join(TEST_ROOT, 'library')

let serverProcess: any

// --- Helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setupFileSystem() {
  try {
    await fs.rm(TEST_ROOT, { recursive: true, force: true })
    await fs.mkdir(USER_DATA_PATH, { recursive: true })
    await fs.mkdir(LIBRARY_PATH, { recursive: true })

    // 1. Movie Setup
    await fs.mkdir(path.join(LIBRARY_PATH, 'Movies'), { recursive: true })
    await fs.writeFile(path.join(LIBRARY_PATH, 'Movies', 'The Matrix.mp4'), 'dummy content')
    await fs.writeFile(path.join(LIBRARY_PATH, 'Movies', 'Inception.mkv'), 'dummy content')

    // 2. TV Show Setup (Smart Regex)
    await fs.mkdir(path.join(LIBRARY_PATH, 'TV', 'Breaking Bad', 'Season 1'), { recursive: true })
    await fs.writeFile(
      path.join(LIBRARY_PATH, 'TV', 'Breaking Bad', 'Season 1', 'Breaking Bad S01E01.mp4'),
      'dummy'
    )
    await fs.writeFile(
      path.join(LIBRARY_PATH, 'TV', 'Breaking Bad', 'Season 1', 'Breaking Bad S01E02.mp4'),
      'dummy'
    )

    // 3. TV Show Setup (Alphabetic Fallback)
    await fs.mkdir(path.join(LIBRARY_PATH, 'TV', 'Unknown Show', 'Season 1'), { recursive: true })
    await fs.writeFile(
      path.join(LIBRARY_PATH, 'TV', 'Unknown Show', 'Season 1', 'Chapter 1.mp4'),
      'dummy'
    )
    await fs.writeFile(
      path.join(LIBRARY_PATH, 'TV', 'Unknown Show', 'Season 1', 'Chapter 2.mp4'),
      'dummy'
    )
  } catch (e) {
    console.error('FS Setup Failed:', e)
    throw e
  }
}

async function writeSettings() {
  // We need to configure the library path in settings.json so the server knows where to scan
  const settingsPath = path.join(USER_DATA_PATH, 'settings.json')
  const settings = {
    mediaSourcePath: LIBRARY_PATH
    // other defaults
  }
  await fs.writeFile(settingsPath, JSON.stringify(settings))
}

describe('Comprehensive V2 API & Ingestion Tests', async () => {
  before(async () => {
    await setupFileSystem()
    await writeSettings()

    console.log('Spawning server...')
    serverProcess = spawn('npx', ['tsx', 'src/main/server.ts'], {
      env: { ...process.env, PORT: PORT.toString(), USER_DATA_PATH: USER_DATA_PATH },
      shell: true,
      stdio: 'pipe'
    })

    await new Promise<void>((resolve, reject) => {
      let started = false
      const check = (data: Buffer) => {
        const msg = data.toString()
        if (msg.includes('Media Browser Server running') && !started) {
          started = true
          console.log('Server Ready.')
          resolve()
        }
      }
      serverProcess.stdout.on('data', check)
      serverProcess.stderr.on('data', (d: any) => console.error('[Stderr]', d.toString()))
      setTimeout(() => {
        if (!started) reject(new Error('Timeout'))
      }, 10000)
    })
  })

  after(() => {
    if (serverProcess) {
      if (process.platform === 'win32') {
        // Force kill tree
        spawn('taskkill', ['/pid', serverProcess.pid, '/f', '/t'])
      } else {
        serverProcess.kill()
      }
    }
  })

  test('Step 1: Trigger Ingestion (Scan)', async () => {
    // Trigger scan
    const res = await fetch(`${BASE_URL}/maintenance/scan`, { method: 'POST' })
    assert.strictEqual(res.status, 200, 'Scan trigger should return 200')

    // Poll for completion (Wait for Root to have children)
    let retries = 0
    let loaded = false
    while (retries < 10) {
      const check = await fetch(`${BASE_URL}/items?parentId=null`)
      const rootItems = (await check.json()) as any[]
      if (rootItems.length > 0) {
        // Check if children are populated?
        // Wait a bit more for async processing?
        loaded = true
        break
      }
      await sleep(1000)
      retries++
    }
    assert.ok(loaded, 'Library should populate after scan')

    // --- FIX: Enable "Smart Parsing" for TV Folder ---
    const allItemsRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await allItemsRes.json()) as any[]
    const tvFolder = allItems.find((i) => i.name === 'TV')
    assert.ok(tvFolder, 'TV folder should exist')

    // Apply settings
    await fetch(`http://localhost:${PORT}/api/apply-initial-folder-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: [{ id: tvFolder.id, retrieve: true, hint: 'tv' }]
      })
    })

    // Trigger Rescan to apply Parsing Logic (Filesystem-First)
    await fetch(`${BASE_URL}/maintenance/scan`, { method: 'POST' })

    // Wait for rescan (simple delay for now, or poll for a specific known episode update?)
    // Let's wait 2 seconds, which should be plenty for the test data
    await sleep(2000)
  })

  test('Step 2: V2 API - Lean Fields (Default)', async () => {
    // Find "The Matrix"
    const itemsRes = await fetch(`${BASE_URL}/items?fields=id,name,overview`) // Search/Filter not fully impl in router "where" yet for fuzzy name, so use list

    // Wait, ?where[name]=The Matrix.mp4 might work if exact match
    // Or just list all and find in array
    const listRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await listRes.json()) as any[]

    const matrix = allItems.find((i) => i.name.includes('The Matrix'))
    assert.ok(matrix, 'The Matrix file should be found')

    // Verify Lean: Should NOT have 'overview' or 'path' by default (unless CORE_FIELDS changed)
    // CORE: id, parentId, name, type, mediaType, posterPath, watched, isMissing, year, seasonNumber, episodeNumber
    assert.strictEqual(matrix.overview, undefined, 'Overview should be undefined by default')
    assert.strictEqual(matrix.path, undefined, 'Path should be undefined by default')
  })

  test('Step 3: V2 API - Include Param', async () => {
    // Identify The Matrix ID
    const listRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await listRes.json()) as any[]
    const matrix = allItems.find((i) => i.name.includes('The Matrix'))

    const detailRes = await fetch(`${BASE_URL}/items/${matrix.id}?include=path,birthtime`)
    const detail = await detailRes.json()

    assert.ok(detail.path, 'Path should be included when requested')
    assert.ok(detail.birthtime, 'Birthtime should be included when requested')
  })

  test('Step 4: Smart Episode Parsing', async () => {
    // Find Breaking Bad folder
    const listRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await listRes.json()) as any[]
    const bbFolder = allItems.find((i) => i.name === 'Breaking Bad')
    assert.ok(bbFolder, 'Breaking Bad folder should exist')

    // Drill down: BB -> Season 1 (Assuming 1 level nesting or 2?
    // Path: TV/Breaking Bad/Season 1/S01E01.mp4
    // So: Root -> TV -> Breaking Bad -> Season 1 -> S01E01)
    // Let's just find the file "Breaking Bad S01E01.mp4" globally via generic list for simplicity of test
    const ep1 = allItems.find((i) => i.name.includes('S01E01'))

    assert.ok(ep1, 'Episode 1 file should exist')
    assert.strictEqual(ep1.seasonNumber, 1, 'Season should be 1')
    assert.strictEqual(ep1.episodeNumber, 1, 'Episode should be 1')
    assert.strictEqual(ep1.mediaType, 'episode', 'MediaType should be episode')
  })

  test('Step 5: Alphabetic Fallback', async () => {
    // Find items for Unknown Show
    const listRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await listRes.json()) as any[]

    // Chapter 1.mp4 -> Should be index 1 implicitly?
    // If sorting worked in ingestion, Chapter 1 comes before Chapter 2.
    const ep1 = allItems.find((i) => i.name === 'Chapter 1.mp4')
    const ep2 = allItems.find((i) => i.name === 'Chapter 2.mp4')

    assert.ok(ep1, 'Chapter 1 should be found')
    assert.ok(ep2, 'Chapter 2 should be found')

    // Verify Fallback Logic:
    // filesystem.service.ts uses `determineEpisodeNumbers`.
    // If "Consensus" failed (no SxxExx), it falls back to index.
    assert.strictEqual(ep1.episodeNumber, 1, 'Fallback should assign episode 1')
    assert.strictEqual(ep2.episodeNumber, 2, 'Fallback should assign episode 2')
  })

  test('Step 6: Contextual Sorting (Episodes)', async () => {
    // Find Season 1 of Breaking Bad
    // We need its ID.
    // Let's assume we can fetch children of the "Season 1" folder.
    const listRes = await fetch(`${BASE_URL}/items?limit=100`)
    const allItems = (await listRes.json()) as any[]
    const s1 = allItems.find((i) => i.name === 'Season 1' && i.mediaType === 'season') // Might need check parent

    if (!s1) {
      console.log('Skipping Contextual Sort test - Season 1 folder not easily found in flat list')
      return
    }

    const childrenRes = await fetch(`${BASE_URL}/items/${s1.id}/children`)
    const children = (await childrenRes.json()) as any[]

    // Assert sorted by episode number
    // E01, E02...
    assert.strictEqual(children[0].episodeNumber, 1)
    assert.strictEqual(children[1].episodeNumber, 2)
  })
})
