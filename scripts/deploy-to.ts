import { $ } from 'bun'
import fs from 'fs/promises'
import path from 'path'

const server = process.argv[2]
if (!server) {
  console.error('Usage: bun deploy <server>')
  process.exit(1)
}

// Find the most recent .deb in dist/
const distFiles = await fs.readdir('dist').catch(() => [] as string[])
const debFiles = distFiles.filter((f) => f.endsWith('.deb'))
if (debFiles.length === 0) {
  console.error("[ERROR] No .deb file found in dist/. Run 'bun run publish:linux-arm' first.")
  process.exit(1)
}
// Pick the most recently modified one
const withStats = await Promise.all(
  debFiles.map(async (f) => ({ f, mtime: (await fs.stat(path.join('dist', f))).mtime }))
)
const debFile = path.join('dist', withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0].f)

console.log('==========================================')
console.log(` Deploying: ${debFile}`)
console.log(` Target:    ${server}`)
console.log('==========================================')

console.log('[1/2] Uploading to /tmp/kinome.deb...')
await $`scp ${debFile} ${server}:/tmp/kinome.deb`

console.log('[2/2] Installing and restarting service...')
await $`ssh -t ${server} "sudo dpkg -i /tmp/kinome.deb && sudo systemctl restart kinome"`

console.log('\n[SUCCESS] Deployed successfully.')
