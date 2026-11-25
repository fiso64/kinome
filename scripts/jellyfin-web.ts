/**
 * Replaces vendor/jellyfin-web with the web client from the pinned Jellyfin
 * release in src/main/jellyfin/web.ts. Update the archive and its checksum
 * there together with JELLYFIN_VERSION, then run:
 *
 *   bun scripts/jellyfin-web.ts
 */
import { $ } from 'bun'
import { mkdir, mkdtemp, rm, rename } from 'node:fs/promises'
import path from 'node:path'
import { RELEASE_ARCHIVE } from '../src/main/jellyfin/web'

const target = path.resolve(import.meta.dir, '../vendor/jellyfin-web')
// Unpacked beside the target, so the final move is a rename on one file system.
await mkdir(path.dirname(target), { recursive: true })
const work = await mkdtemp(path.join(path.dirname(target), '.jellyfin-web-'))
try {
  const archive = path.join(work, 'jellyfin.tar.xz')
  console.log(`Downloading ${RELEASE_ARCHIVE.url}`)
  const response = await fetch(RELEASE_ARCHIVE.url)
  if (!response.ok) throw new Error(`Download failed with ${response.status}.`)
  await Bun.write(archive, response)
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(archive).arrayBuffer()).digest('hex')
  if (hash !== RELEASE_ARCHIVE.sha256) throw new Error(`Checksum ${hash} does not match the pinned ${RELEASE_ARCHIVE.sha256}.`)
  await $`tar -xJf ${archive} -C ${work} jellyfin/jellyfin-web`
  await rm(target, { recursive: true, force: true })
  await rename(path.join(work, 'jellyfin', 'jellyfin-web'), target)
  console.log(`Wrote ${path.relative(process.cwd(), target)}`)
} finally {
  await rm(work, { recursive: true, force: true })
}
