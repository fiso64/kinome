import { $ } from 'bun'
import { parseArgs } from 'util'
import path from 'path'
import fs from 'fs/promises'

// Read version from package.json
const pkg = await fs.readFile('package.json', 'utf-8')
const version = JSON.parse(pkg).version

// 1. Parse Arguments
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    target: { type: 'string' }
  },
  strict: true,
  allowPositionals: true
})

const rawTarget = values.target // e.g. 'windows-x64'
if (!rawTarget) {
  console.error('❌ Error: --target is required (e.g., linux-arm64, windows-x64)')
  process.exit(1)
}

const isWinTarget = rawTarget.includes('windows')
const bunTarget = rawTarget.startsWith('bun-') ? rawTarget : `bun-${rawTarget}`

// 2. Setup Paths
const ext = isWinTarget ? '.exe' : ''
const distRoot = path.resolve('dist')
const buildDir = path.join(distRoot, rawTarget) // dist/windows-x64
const outFile = path.join(buildDir, 'kinome' + ext)

console.log(`\n🚀 Starting build for: ${rawTarget}`)

// 3. Clean & Prep
await fs.rm(buildDir, { recursive: true, force: true })
await fs.mkdir(buildDir, { recursive: true })

// 4. Compile Go Handler
console.log('🐹 Compiling Go Handler...')
const goArchMap: Record<string, { goos: string; goarch: string }> = {
  'windows-x64': { goos: 'windows', goarch: 'amd64' },
  'linux-x64': { goos: 'linux', goarch: 'amd64' },
  'linux-arm64': { goos: 'linux', goarch: 'arm64' },
  'darwin-x64': { goos: 'darwin', goarch: 'amd64' },
  'darwin-arm64': { goos: 'darwin', goarch: 'arm64' }
}

const goTarget = goArchMap[rawTarget]
if (goTarget) {
  const handlerExt = goTarget.goos === 'windows' ? '-win.exe' : ''
  const ldflags = goTarget.goos === 'windows' ? '-s -w -H windowsgui' : '-s -w'
  const handlerOut = `public/bin/kinome-handler${handlerExt}`

  try {
    // Ensure the bin directory exists
    await fs.mkdir('public/bin', { recursive: true })
    console.log(`   Target: ${goTarget.goos}/${goTarget.goarch} -> ${handlerOut}`)
    await $`cd src/handler && cross-env GOOS=${goTarget.goos} GOARCH=${goTarget.goarch} go build -ldflags=${ldflags} -o ../../${handlerOut} .`
  } catch (e) {
    console.error('❌ Go Handler Compilation Failed')
    process.exit(1)
  }
}

// 5. Build Frontend
console.log('🎨 Building Frontend...')
await $`bun run build`

// 6. Compile Backend
console.log('⚙️  Compiling Backend...')
try {
  await $`bun build --compile --target=${bunTarget} --minify --sourcemap --define "process.env.NODE_ENV='production'" ./src/main/server.ts --outfile ${outFile}`
} catch (e) {
  console.error('❌ Backend Compilation Failed')
  process.exit(1)
}

// 6. Copy Assets
console.log('📂 Copying Assets...')
const outDest = path.join(buildDir, 'out')
await fs.mkdir(outDest, { recursive: true })
await fs.cp(path.resolve('out'), outDest, { recursive: true })

const publicDest = path.join(buildDir, 'public')
await fs.mkdir(publicDest, { recursive: true })
await fs.cp(path.resolve('public'), publicDest, { recursive: true })

// 7. Packaging (Branch based on OS)
if (isWinTarget) {
  console.log('📦 Zipping artifact (Windows)...')
  const zipPath = path.join(distRoot, `kinome-${rawTarget}.zip`)

  // Ensure clean state
  await fs.rm(zipPath, { force: true })

  try {
    if (process.platform === 'win32') {
      await $`powershell Compress-Archive -Path "${buildDir}\\*" -DestinationPath "${zipPath}" -Force`
    } else {
      const cwd = process.cwd()
      process.chdir(buildDir)
      await $`zip -r ${zipPath} .`
      process.chdir(cwd)
    }
    console.log(`\n✅ Build Complete!`)
    console.log(`   Artifact: ${zipPath}`)
  } catch (e) {
    console.error('❌ Zipping Failed:', e)
    process.exit(1)
  }
} else {
  // --- LINUX (.deb via NFPM) ---
  console.log('📦 Packaging .deb with NFPM (Linux)...')

  const archMap: Record<string, string> = {
    'linux-x64': 'amd64',
    'linux-arm64': 'arm64'
  }

  const debArch = archMap[rawTarget]
  if (!debArch) {
    console.error(`❌ Error: Could not map target '${rawTarget}' to a Debian architecture.`)
    process.exit(1)
  }

  try {
    const debFilename = `kinome_${version}_${debArch}.deb`
    const debPath = path.join(distRoot, debFilename)

    // Ensure clean state
    await fs.rm(debPath, { force: true })

    // Generate Config
    const cleanBuildDir = buildDir.replaceAll('\\', '/')
    let nfpmContent = await fs.readFile('nfpm.yaml', 'utf-8')

    nfpmContent = nfpmContent
      .replaceAll('${VERSION}', version)
      .replaceAll('${ARCH}', debArch)
      .replaceAll('${BUILD_DIR}', cleanBuildDir)

    const tempConfigPath = 'nfpm.temp.yaml'
    await fs.writeFile(tempConfigPath, nfpmContent)

    await $`nfpm pkg --packager deb --target ${debPath} -f ${tempConfigPath}`

    await fs.rm(tempConfigPath)

    console.log(`\n✅ Build Complete!`)
    console.log(`   Artifact: ${debPath}`)
  } catch (e) {
    console.error('❌ NFPM Packaging Failed:', e)
    await fs.rm('nfpm.temp.yaml').catch(() => { })
    process.exit(1)
  }
}
