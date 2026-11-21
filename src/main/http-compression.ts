export function acceptsGzip(request: Request): boolean {
  return request.headers.get('accept-encoding')?.split(',').some((entry) => {
    const [coding, weight = '1'] = entry.trim().toLowerCase().split(/\s*;\s*q\s*=\s*/)
    return coding === 'gzip' && Number(weight) > 0
  }) ?? false
}

/** Negotiate compression for dynamic text without buffering compressed output. */
export function textResponse(request: Request, text: string | null, contentType: string): Response {
  const headers = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'private, no-store', Vary: 'Accept-Encoding' })
  if (!acceptsGzip(request)) return new Response(text, { headers })
  headers.set('Content-Encoding', 'gzip')
  const body = text === null ? null : new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(body, { headers })
}
