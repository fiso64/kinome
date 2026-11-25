/**
 * Times the Jellyfin listing routes against a synthetic library and counts the
 * SQL statements each request prepares. Run separately from the test suite:
 *
 *   bun scripts/jellyfin-benchmark.ts [movies] [series]
 */
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { createServiceTestContext } from '../src/main/database/test-helpers'
import { buildApp } from '../src/main/http-app'
import * as accountRepo from '../src/main/database/repositories/account.repo'
import { setUserDataPath } from '../src/main/services/paths.service'
import { LIBRARIES } from '../src/main/jellyfin/ids'

const [movies = 5000, series = 300] = process.argv.slice(2).map(Number)
const SEASONS = 3
const EPISODES = 20
const dataPath = await mkdtemp(join(tmpdir(), 'kinome-jellyfin-benchmark-'))
setUserDataPath(dataPath)
console.log = () => {}
console.debug = () => {}
const ctx = createServiceTestContext()
const app = buildApp()
accountRepo.createAccount('admin', 'admin', await bcrypt.hash('q', 1), 'admin')
const id = (prefix: string, n: number) => (prefix + n.toString(16).padStart(8, '0')).padEnd(64, '0')
const genres = ['Drama', 'Comedy', 'Thriller', 'Science Fiction', 'Animation', 'Documentary']

const started = performance.now()
ctx.db.transaction(() => {
  for (let n = 0; n < movies; n++) {
    ctx.seedEntities([{ id: `m${n}`, tmdbId: 1_000_000 + n, mediaType: 'movie', title: `Movie ${n}`, year: 1950 + (n % 75) }])
    ctx.seedGenres(`m${n}`, [genres[n % genres.length]])
    ctx.seedItems([
      { id: id('a', n), name: `Movie ${n}`, type: 'folder', entityId: `m${n}`, path: `Movie ${n}` },
      { id: id('b', n), parentId: id('a', n), name: `Movie ${n}.mkv`, path: `Movie ${n}/Movie ${n}.mkv` }
    ])
  }
  for (let s = 0; s < series; s++) {
    ctx.seedEntities([{ id: `s${s}`, tmdbId: 2_000_000 + s, mediaType: 'tv', title: `Series ${s}` }])
    ctx.seedItems([{ id: id('c', s), name: `Series ${s}`, type: 'folder', entityId: `s${s}`, path: `Series ${s}` }])
    for (let season = 1; season <= SEASONS; season++) {
      const seasonId = id('d', s * 10 + season)
      ctx.seedEntities([{ id: `s${s}-${season}`, mediaType: 'season', seasonNumber: season }])
      ctx.seedItems([{ id: seasonId, parentId: id('c', s), name: `Season ${season}`, type: 'folder', entityId: `s${s}-${season}`, path: `Series ${s}/Season ${season}` }])
      for (let episode = 1; episode <= EPISODES; episode++) {
        const key = `s${s}-${season}-${episode}`
        ctx.seedEntities([{ id: key, mediaType: 'episode', seasonNumber: season, episodeNumber: episode, title: `Episode ${episode}` }])
        ctx.seedItems([{ id: id('e', (s * 10 + season) * 100 + episode), parentId: seasonId, name: `${key}.mkv`, entityId: key, path: `Series ${s}/Season ${season}/${key}.mkv` }])
      }
    }
  }
  // Some progress to make Next Up and Resume realistic.
  const state = ctx.db.prepare('INSERT INTO user_state (item_id, user_id, watched, last_watched_at, next_up_episode_id, playback_position) VALUES (?, ?, ?, ?, ?, ?)')
  for (let s = 0; s < Math.min(series, 40); s++) {
    state.run(id('e', (s * 10 + 1) * 100 + 1), 'admin', 1, Date.now() - s, null, 0)
    state.run(id('c', s), 'admin', 0, Date.now() - s, id('e', (s * 10 + 1) * 100 + 2), 0)
  }
  for (let n = 0; n < 30; n++) state.run(id('b', n), 'admin', 0, Date.now() - n, null, 600)
})()
const seeded = Math.round(performance.now() - started)

const login = await app.handle(new Request('http://localhost/jellyfin/Users/AuthenticateByName', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'MediaBrowser Client="Bench", Device="cli", DeviceId="bench", Version="1"' },
  body: JSON.stringify({ Username: 'admin', Pw: 'q' })
}))
const token = (await login.json() as { AccessToken: string }).AccessToken

let statements = 0
const prepare = Database.prototype.prepare
const query = Database.prototype.query
Database.prototype.prepare = function (...args: Parameters<typeof prepare>) { statements++; return prepare.apply(this, args) } as typeof prepare
Database.prototype.query = function (...args: Parameters<typeof query>) { statements++; return query.apply(this, args) } as typeof query
// BENCH_TRACE=1 lists each statement's time for the last run of every route.
const trace: { sql: string; ms: number }[] = []
if (process.env.BENCH_TRACE) {
  // Database.query caches statements. Wrap each statement once.
  const wrapped = new WeakSet<object>()
  const wrap = (statement: any, sql: string) => {
    if (wrapped.has(statement)) return statement
    wrapped.add(statement)
    for (const method of ['all', 'get', 'run', 'values']) {
      const original = statement[method]
      statement[method] = (...args: unknown[]) => { const t = performance.now(); try { return original.apply(statement, args) } finally { trace.push({ sql, ms: performance.now() - t }) } }
    }
    return statement
  }
  const tracedPrepare = Database.prototype.prepare
  const tracedQuery = Database.prototype.query
  Database.prototype.prepare = function (sql: string, ...rest: any[]) { return wrap(tracedPrepare.call(this, sql, ...rest), sql) } as typeof prepare
  Database.prototype.query = function (sql: string, ...rest: any[]) { return wrap(tracedQuery.call(this, sql, ...rest), sql) } as typeof query
}

const show = id('c', 7).slice(0, 32)
const season = id('d', 7 * 10 + 2).slice(0, 32)
const fields = 'Fields=PrimaryImageAspectRatio,MediaSourceCount,BasicSyncInfo,Overview,Genres'
const routes = [
  ['movies page', `/Items?ParentId=${LIBRARIES.movies.id}&Recursive=true&IncludeItemTypes=Movie&${fields}&SortBy=SortName&SortOrder=Ascending&StartIndex=2400&Limit=100`],
  ['movies by genre', `/Items?ParentId=${LIBRARIES.movies.id}&Recursive=true&IncludeItemTypes=Movie&Genres=Thriller&SortBy=PremiereDate&SortOrder=Descending&Limit=100`],
  ['movies unplayed', `/Items?ParentId=${LIBRARIES.movies.id}&Recursive=true&IncludeItemTypes=Movie&Filters=IsUnplayed&Limit=100`],
  ['series page', `/Items?ParentId=${LIBRARIES.tvshows.id}&IncludeItemTypes=Series&${fields}&SortBy=SortName&Limit=100`],
  ['latest movies', `/Items/Latest?ParentId=${LIBRARIES.movies.id}&Limit=16&Fields=PrimaryImageAspectRatio`],
  ['latest series', `/Items/Latest?ParentId=${LIBRARIES.tvshows.id}&Limit=16`],
  ['resume', '/UserItems/Resume?Limit=12&MediaTypes=Video'],
  ['next up', '/Shows/NextUp?Limit=24&Fields=PrimaryImageAspectRatio'],
  ['seasons', `/Shows/${show}/Seasons`],
  ['episodes', `/Shows/${show}/Episodes?SeasonId=${season}&Fields=Overview,MediaSources`],
  ['series detail', `/Items/${show}`],
  ['movie detail', `/Items/${id('a', Math.floor(movies / 2)).slice(0, 32)}`],
  ['search', '/Items?searchTerm=Movie 25&Recursive=true&IncludeItemTypes=Movie,Series&Limit=24'],
  ['genres', `/Genres?ParentId=${LIBRARIES.movies.id}`],
  ['sonarr lookup', '/Items?recursive=true&includeItemTypes=Series&fields=Path,ProviderIds&years=2022'],
] as const

console.info(`Seeded ${movies} movies and ${series} series (${series * SEASONS * EPISODES} episodes) in ${seeded} ms.`)
for (const [name, path] of routes.filter(([name]) => !process.env.BENCH_ONLY || name === process.env.BENCH_ONLY)) {
  const times: number[] = []
  let used = 0
  for (let run = 0; run < 7; run++) {
    statements = 0
    trace.length = 0
    const t0 = performance.now()
    const response = await app.handle(new Request(`http://localhost/jellyfin${path}`, { headers: { Accept: 'application/json', Authorization: `MediaBrowser Token="${token}"` } }))
    await response.arrayBuffer()
    times.push(performance.now() - t0)
    used = statements
    if (response.status !== 200) throw new Error(`${name}: ${response.status}`)
  }
  times.sort((a, b) => a - b)
  console.info(`${name.padEnd(16)} median ${times[3].toFixed(1).padStart(7)} ms   statements ${used}`)
  if (process.env.BENCH_TRACE) for (const { sql, ms } of trace) console.info(`    ${ms.toFixed(1).padStart(6)} ms  ${sql.replace(/\s+/g, ' ').slice(0, 110)}`)
}
ctx.cleanup()
await rm(dataPath, { recursive: true, force: true })
// Services keep timers open, so a finished run ends here.
process.exit(0)
