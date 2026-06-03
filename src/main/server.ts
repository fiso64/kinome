import { staticPlugin } from '@elysiajs/static'
import path from 'path'
import fs from 'fs'

import { initializeStartup } from './services/startup.service'
import * as libraryService from './services/library.service'
import * as settingsService from './services/settings.service'
import { WebTransport } from './transport/web.transport'
import { setTransport } from './transport.registry'
import * as authService from './services/auth.service'
import { buildApp } from './http-app'
import * as handlerService from './services/handler.service'
import * as accountRepo from './database/repositories/account.repo'
import bcrypt from 'bcryptjs'

// --- Startup ---

/**
 * Resolves the directory where settings.json and the database should live.
 * Priority:
 * 1. Environment Variable (KINOME_DATA) - Best for Docker/Systemd
 * 2. "./data" folder relative to CWD - Best for Portable/Dev use
 * 3. OS Default (AppData/.config) - Best for standard Desktop install
 */

function resolveEnvPort(): number | undefined {
  const rawPort = process.env.KINOME_PORT ?? process.env.PORT
  if (!rawPort) return undefined

  const parsed = Number(rawPort)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`[Startup] Ignoring invalid port from environment: ${rawPort}`)
    return undefined
  }

  return parsed
}

function resolveUserDataPath(): string {
  const appName = 'kinome'

  if (process.env.KINOME_DATA) {
    console.log(`[Startup] Using data path from env: ${process.env.KINOME_DATA}`)
    return process.env.KINOME_DATA
  }

  const localDataPath = path.resolve(process.cwd(), 'data')
  if (fs.existsSync(localDataPath)) {
    console.log(`[Startup] Detected 'data' folder. Running in Portable Mode: ${localDataPath}`)
    return localDataPath
  }

  let osPath = ''
  if (process.platform === 'win32') {
    osPath = path.join(process.env.APPDATA || '', appName)
  } else if (process.platform === 'darwin') {
    osPath = path.join(process.env.HOME || '', 'Library', 'Application Support', appName)
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')
    osPath = path.join(xdgConfig, appName)
  }

  console.log(`[Startup] Using OS default data path: ${osPath}`)
  return osPath
}

const userDataPath = resolveUserDataPath()

if (!fs.existsSync(userDataPath)) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
  } catch (e) {
    console.error(`[Startup] CRITICAL: Could not create data directory at ${userDataPath}`)
    console.error(`Please check permissions or set KINOME_DATA environment variable.`)
    process.exit(1)
  }
}

initializeStartup(userDataPath)

const webTransport = new WebTransport()
setTransport(webTransport)

// Build the Elysia app (all API routes defined in http-app.ts)
const app = buildApp()

// WebSocket transport (server-specific; needs the WebTransport instance for getCurrentStatus)
app.ws('/ws', {
  open(ws) {
    console.log(`[WebTransport] Client connected: ${ws.id}`)
    ws.subscribe('broadcast')
    const token = (ws as any).data?.query?.token as string | undefined
    if (token) {
      const session = authService.validateToken(token)
      if (session) {
        ws.subscribe(`broadcast:${session.accountId}`)
        console.log(`[WebTransport] Client ${ws.id} subscribed to broadcast:${session.accountId}`)
      }
    }
    ws.send(
      JSON.stringify({ type: 'scan-status-changed', data: webTransport.getCurrentStatus() })
    )
  },
  close(ws) {
    console.log(`[WebTransport] Client disconnected: ${ws.id}`)
  }
})

// Installer scripts (served as text/plain)
app
  .get('/install-kinome-handler.ps1', async ({ query, request, set }) => {
    const url = new URL(request.url)
    const secret = (query.secret as string) || url.searchParams.get('secret') || undefined

    let baseUrl = url.origin
    const forwardedProto = request.headers.get('x-forwarded-proto')
    if (forwardedProto === 'https' && baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'https://')
    }

    set.headers['Content-Type'] = 'text/plain; charset=utf-8'
    set.headers['Cache-Control'] = 'no-store'

    return handlerService.generateWindowsInstaller(secret, baseUrl)
  })
  .get('/install-kinome-handler.sh', async ({ query, request, set }) => {
    const url = new URL(request.url)
    const secret = (query.secret as string) || url.searchParams.get('secret') || undefined

    let baseUrl = url.origin
    const forwardedProto = request.headers.get('x-forwarded-proto')
    if (forwardedProto === 'https' && baseUrl.startsWith('http://')) {
      baseUrl = baseUrl.replace('http://', 'https://')
    }

    set.headers['Content-Type'] = 'text/plain; charset=utf-8'
    set.headers['Cache-Control'] = 'no-store'

    return handlerService.generateLinuxInstaller(secret, baseUrl)
  })
  .get('/bin/*', ({ params, set }) => {
    const exeDir = path.dirname(process.execPath)
    const sourceDir = (import.meta as any).dir

    const possiblePaths = [
      path.join(exeDir, 'public', 'bin', params['*']),
      path.join(exeDir, 'out', 'renderer', 'bin', params['*']),
      path.resolve(sourceDir, '../../out/renderer/bin', params['*']),
      path.join(process.cwd(), 'public', 'bin', params['*'])
    ]

    let binPath = ''
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        binPath = p
        break
      }
    }

    if (!binPath) {
      set.status = 404
      return 'File not found'
    }

    if (binPath.endsWith('.exe')) {
      set.headers['Content-Type'] = 'application/x-msdownload'
    } else {
      set.headers['Content-Type'] = 'application/octet-stream'
    }
    return Bun.file(binPath)
  })

// 3. Static Files & Frontend Serving
if (process.env.NODE_ENV === 'production') {
  const exeDir = path.dirname(process.execPath)
  const sourceDir = (import.meta as any).dir
  const pathSibling = path.join(exeDir, 'out', 'renderer')
  const pathDev = path.resolve(sourceDir, '../../out/renderer')

  const publicSibling = path.join(exeDir, 'public')
  const publicDev = path.resolve(sourceDir, '../../public')
  const publicPath = fs.existsSync(publicSibling) ? publicSibling : publicDev

  if (fs.existsSync(publicPath)) {
    console.log(`[Server] Serving public assets from: ${publicPath}`)
    app.use(
      staticPlugin({
        assets: publicPath,
        prefix: '/'
      })
    )
  }

  let distPath = ''

  if (fs.existsSync(pathSibling)) {
    console.log(`[Server] Detected production layout. Serving from: ${pathSibling}`)
    distPath = pathSibling
  } else if (fs.existsSync(pathDev)) {
    console.log(`[Server] Detected development layout. Serving from: ${pathDev}`)
    distPath = pathDev
  } else {
    console.error('[Server] CRITICAL: Could not locate frontend assets.')
    distPath = pathSibling
  }

  app.use(
    staticPlugin({
      assets: distPath,
      prefix: '/'
    })
  )

  app.get('*', () => {
    const indexPath = path.join(distPath, 'index.html')
    if (fs.existsSync(indexPath)) {
      return Bun.file(indexPath)
    }
    return new Response('Frontend not found', { status: 404 })
  })
} else {
  app.get('/', () => {
    return `
      <html>
        <head><title>Kinome Backend</title></head>
        <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #121212; color: #fff;">
          <h1>🎬 Kinome Backend is running</h1>
          <p>This is the API server. To view the app, open <a href="http://localhost:3000" style="color: #4facfe;">http://localhost:3000</a> (Vite Dev Server).</p>
        </body>
      </html>
    `
  })
}

async function start() {
  const { version } = await import('../../package.json')
  console.log(`[Server] Starting kinome v${version}`)
  console.log('[Server] Loading database into memory...')
  await libraryService.loadDbIntoMemory()
  console.log('[Server] Database loaded.')

  if (process.env.NODE_ENV !== 'production' && accountRepo.getAccountCount() === 0) {
    const hash = await bcrypt.hash('q', 4)
    accountRepo.createAccount('admin', 'admin', hash, 'admin')
    accountRepo.createAccount('user', 'user', hash, 'normal')
    console.log('[Dev] Auto-seeded accounts: admin/q (admin), user/q (normal)')
  } else {
    authService.ensureSetupToken()
  }

  const settings = await settingsService.readSettings()

  const envPort = resolveEnvPort()
  const finalPort =
    envPort ?? (process.env.NODE_ENV === 'production' ? settings.serverPort || 3000 : 3001)
  const host = process.env.KINOME_HOST || settings.serverHost || '0.0.0.0'

  app.listen({ port: finalPort, hostname: host }, (server) => {
    webTransport.initialize(server)
    console.log(`🦊 Elysia is running at http://${server?.hostname}:${server?.port}`)
  })
}

start().catch((err) => {
  console.error('[Server] Failed to start:', err)
  process.exit(1)
})
