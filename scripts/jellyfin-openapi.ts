/**
 * Pins the Jellyfin OpenAPI document that the adapter in src/main/jellyfin follows.
 *
 *   bun scripts/jellyfin-openapi.ts [spec URL or file]
 *
 * Keeps the operations the adapter routes, the schemas they reach, and no
 * descriptions. Writes openapi.json, which the tests validate responses
 * against, and the generated types in openapi.d.ts.
 */
import { Glob } from 'bun'
import path from 'node:path'
import { JELLYFIN_VERSION as PINNED_VERSION } from '../src/main/jellyfin/web'
const source = process.argv[2] ?? 'https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json'
const root = path.resolve(import.meta.dir, '..')
const target = path.join(root, 'src/main/jellyfin')

const spec = source.startsWith('http') ? await (await fetch(source)).json() : await Bun.file(source).json()
if (spec.info?.version !== PINNED_VERSION) {
  throw new Error(`Expected Jellyfin ${PINNED_VERSION}, got ${spec.info?.version}. Update JELLYFIN_VERSION in src/main/jellyfin/web.ts deliberately.`)
}

// Routes are declared as route('GET', '/Items/{itemId}', ...).
const operations = new Set<string>()
for await (const file of new Glob('*.ts').scan(target)) {
  const text = await Bun.file(path.join(target, file)).text()
  for (const match of text.matchAll(/route\('(GET|POST|DELETE|HEAD)', '([^']+)'/g)) operations.add(`${match[1]} ${match[2]}`)
}

const paths: Record<string, Record<string, unknown>> = {}
for (const operation of operations) {
  const [method, route] = operation.split(' ')
  const definition = spec.paths[route]?.[method.toLowerCase()]
  if (!definition) continue
  ;(paths[route] ??= {})[method.toLowerCase()] = definition
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (['description', 'summary', 'example', 'examples', 'x-jellyfin-version'].includes(key)) continue
    result[key] = strip(entry)
  }
  return result
}

// Keep the schemas reachable from the kept operations.
const schemas: Record<string, unknown> = {}
const pending = [JSON.stringify(paths)]
while (pending.length) {
  for (const match of pending.pop()!.matchAll(/#\/components\/schemas\/(\w+)/g)) {
    if (schemas[match[1]]) continue
    schemas[match[1]] = spec.components.schemas[match[1]]
    pending.push(JSON.stringify(schemas[match[1]]))
  }
}

const pinned = strip({
  openapi: spec.openapi, info: spec.info, paths,
  components: { schemas: Object.fromEntries(Object.entries(schemas).sort()), securitySchemes: spec.components.securitySchemes }
})
await Bun.write(path.join(target, 'openapi.json'), JSON.stringify(pinned, null, 1) + '\n')
const generate = Bun.spawnSync(['bunx', '--bun', 'openapi-typescript@7.13.0', path.join(target, 'openapi.json'), '-o', path.join(target, 'openapi.d.ts')], { stdout: 'inherit', stderr: 'inherit' })
if (generate.exitCode !== 0) throw new Error('openapi-typescript failed')
console.log(`Pinned ${Object.keys(paths).length} paths and ${Object.keys(schemas).length} schemas of Jellyfin ${PINNED_VERSION}.`)
