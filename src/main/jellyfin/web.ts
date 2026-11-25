/**
 * The Jellyfin release Kinome follows, and the web client vendored from it.
 *
 * The official Android app and other wrappers open the server's own web
 * client, so Kinome serves Jellyfin's at /jellyfin/web from vendor/jellyfin-web.
 * scripts/jellyfin-web.ts replaces that folder from RELEASE_ARCHIVE, and
 * scripts/jellyfin-openapi.ts pins the API document for JELLYFIN_VERSION.
 */
import fs from 'node:fs'
import path from 'node:path'

export const JELLYFIN_VERSION = '12.4.0'
export const RELEASE_ARCHIVE = {
  url: 'https://repo.jellyfin.org/files/server/linux/stable/v12.4/amd64/jellyfin_12.4-amd64.tar.xz',
  sha256: '29831bfda5699018d1d3058085c6b837fb31da34b5eab3c98259aa12da80375f'
}

// Beside the executable when packaged, in the repository otherwise.
const root = [
  path.join(path.dirname(process.execPath), 'vendor', 'jellyfin-web'),
  path.resolve(import.meta.dir, '../../../vendor/jellyfin-web')
].find((candidate) => fs.existsSync(path.join(candidate, 'index.html')))

/** Serves the web client for a path below the API base, or returns undefined when the path is not the web client's. */
export function serveWebClient(request: Request, requestPath: string, baseUrl: string): Response | undefined {
  if (requestPath === '/' || /^\/web$/i.test(requestPath)) return Response.redirect(`${baseUrl}/web/`, 302)
  const match = /^\/web\/(.*)$/i.exec(requestPath)
  if (!match) return undefined
  if (!root) return new Response('The Jellyfin web client is not installed.', { status: 404 })
  let name: string
  try {
    name = decodeURIComponent(match[1]) || 'index.html'
  } catch {
    return new Response(null, { status: 404 })
  }
  const file = path.resolve(root, name)
  const info = file.startsWith(root + path.sep) ? fs.statSync(file, { throwIfNoEntry: false }) : undefined
  if (!info?.isFile()) return new Response(null, { status: 404 })
  // Built files carry a content hash in their names. The rest are revalidated, since an update changes them.
  const modified = info.mtime.toUTCString()
  const headers = { 'Cache-Control': /\.[0-9a-f]{20}\.\w+$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache', 'Last-Modified': modified }
  if (request.headers.get('if-modified-since') === modified) return new Response(null, { status: 304, headers })
  return new Response(Bun.file(file), { headers })
}
