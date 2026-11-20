import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { GlobalConfig } from '../src/shared/types'

const root = path.resolve(import.meta.dir, '..')
const fixtures = path.join(root, 'test-data')
const libraryLocation = path.join(fixtures, 'test-lib-small', '.library')
const dataPath = path.join(fixtures, '.kinome')

if (!(await stat(libraryLocation).catch(() => null))?.isDirectory()) {
  throw new Error(`Test library not found at ${libraryLocation}`)
}

await mkdir(dataPath, { recursive: true })
const settingsFile = Bun.file(path.join(dataPath, 'settings.json'))
const settings: Partial<GlobalConfig> = (await settingsFile.exists()) ? await settingsFile.json() : {}
if (settings.server?.libraryLocation !== libraryLocation) {
  await Bun.write(settingsFile, JSON.stringify({
    server: { ...settings.server, libraryLocation },
    libraryDefaults: settings.libraryDefaults ?? {}
  }, null, 2) + '\n')
}

const dev = Bun.spawn([process.execPath, 'run', 'dev', '--kill-others'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    KINOME_DATA: dataPath,
    KINOME_HOST: 'localhost',
    KINOME_PORT: '3001'
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit'
})

process.on('SIGINT', () => dev.kill('SIGINT'))
process.on('SIGTERM', () => dev.kill('SIGTERM'))
process.exitCode = await dev.exited
