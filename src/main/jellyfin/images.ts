/**
 * Artwork for Jellyfin clients, scaled down to the width a client asks for.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveLibraryPath } from '../services/paths.service'
import * as repositoryService from '../services/repository.service'
import { resizedImage } from '../services/image-resize.service'
import { personFromJellyfinId } from './ids'
import { getItem, imageTag } from './items'
import { JellyfinError, notFound, route, type JellyfinRequest } from './request'

const FIELDS: Record<string, 'posterPath' | 'backdropPath' | 'logoPath'> = {
  primary: 'posterPath', backdrop: 'backdropPath', thumb: 'backdropPath', logo: 'logoPath'
}

function serve(request: JellyfinRequest, file: string, tag: string) {
  const immutable = request.query.get('tag') === tag
  return new Response(request.request.method === 'HEAD' ? null : Bun.file(file), {
    headers: {
      'Content-Type': Bun.file(file).type,
      'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=3600',
      ETag: `"${path.basename(file)}-${tag}"`
    }
  })
}

async function itemImage(request: JellyfinRequest) {
  const type = request.params.imageType.toLowerCase()
  const person = personFromJellyfinId(request.params.itemId.toLowerCase().replaceAll('-', ''))
  if (person !== undefined) {
    const profile = type === 'primary' ? repositoryService.getPerson(person)?.profilePath : undefined
    if (!profile) throw notFound()
    return Response.redirect(`https://image.tmdb.org/t/p/w300${profile}`, 302)
  }
  const field = FIELDS[type]
  if (!field || Number(request.params.imageIndex ?? 0) > 0) throw notFound()
  // Signed in, the account's visibility applies. Otherwise only a tag this server handed out opens the image.
  const item = getItem(request.params.itemId)
  const stored = item?.[field]
  if (!request.session && (!stored || request.query.get('tag') !== imageTag(stored, item?._v))) throw new JellyfinError(401, 'Unauthorized')
  if (!item || !stored) throw notFound()
  const file = [resolveLibraryPath(stored), resolveLibraryPath(path.join('images', stored))]
    .find((candidate): candidate is string => !!candidate && fs.existsSync(candidate))
  if (!file) throw notFound()
  const tag = imageTag(stored, item._v)
  const width = request.query.int('maxWidth') ?? request.query.int('fillWidth') ?? request.query.int('width')
  return serve(request, width ? await resizedImage(file, tag, width) : file, tag)
}

const open = { public: true }

export const imageRoutes = [
  route('GET', '/Items/{itemId}/Images/{imageType}', itemImage, open),
  route('HEAD', '/Items/{itemId}/Images/{imageType}', itemImage, open),
  route('GET', '/Items/{itemId}/Images/{imageType}/{imageIndex}', itemImage, open),
  route('HEAD', '/Items/{itemId}/Images/{imageType}/{imageIndex}', itemImage, open),
  route('GET', '/Users/{userId}/Images/{imageType}', () => { throw notFound() }),
]
