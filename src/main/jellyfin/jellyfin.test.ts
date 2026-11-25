/**
 * The Jellyfin-compatible API: responses conform to the pinned OpenAPI
 * document, account visibility holds on every route, and playback negotiation
 * follows the client's device profile.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { createServiceTestContext, type ServiceTestContext } from '../database/test-helpers'
import { buildApp } from '../http-app'
import * as accountRepo from '../database/repositories/account.repo'
import * as libraryService from '../services/library.service'
import { setUserDataPath } from '../services/paths.service'
import { jellyfinRoutes } from '.'
import { LIBRARIES, toJellyfinId } from './ids'
import { negotiate } from './playback'
import * as events from './events'
import * as authService from '../services/auth.service'
import spec from './openapi.json'

type Schema = Record<string, any>
const schemas = spec.components.schemas as Record<string, Schema>

function resolve(schema: Schema): Schema {
  return schema.$ref ? resolve(schemas[schema.$ref.split('/').pop()!]) : schema
}

function nullable(schema: Schema): boolean {
  return !!schema.nullable || !!schema.allOf?.some((part: Schema) => resolve(part).nullable)
}

/**
 * Validates a value against an OpenAPI 3.0 schema. Unknown object properties
 * are errors, and so are missing non-nullable ones: Jellyfin's Kotlin SDK,
 * used by Android clients, cannot decode a response without them.
 */
function validate(schema: Schema, value: unknown, path = '$', errors: string[] = []): string[] {
  if (value === null) {
    if (!nullable(schema)) errors.push(`${path} is null`)
    return errors
  }
  if (schema.$ref) return validate(resolve(schema), value, path, errors)
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} is ${JSON.stringify(value)}, not one of ${schema.enum.join(', ')}`)
  for (const part of schema.allOf ?? []) validate(part, value, path, errors)
  const options = schema.oneOf ?? schema.anyOf
  if (options && !options.some((option: Schema) => !validate(option, value, path).length)) errors.push(`${path} matches no variant`)
  const type = schema.type ?? (schema.properties ? 'object' : undefined)
  if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} is not a string`)
    else if (schema.format === 'uuid' && !/^[0-9a-f]{32}$|^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) errors.push(`${path} is not a GUID`)
    else if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path} is not a date`)
  } else if (type === 'integer' && !Number.isInteger(value)) errors.push(`${path} is not an integer`)
  else if (type === 'number' && typeof value !== 'number') errors.push(`${path} is not a number`)
  else if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} is not a boolean`)
  else if (type === 'array') {
    if (!Array.isArray(value)) errors.push(`${path} is not an array`)
    else value.forEach((entry, index) => validate(schema.items ?? {}, entry, `${path}[${index}]`, errors))
  } else if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) errors.push(`${path} is not an object`)
    else {
      for (const name of schema.required ?? []) if (!(name in value)) errors.push(`${path}.${name} is missing`)
      for (const [name, property] of Object.entries<Schema>(schema.properties ?? {})) {
        if ((value as Record<string, unknown>)[name] === undefined && !nullable(property)) errors.push(`${path}.${name} is missing`)
      }
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        const property = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined)
        if (property) validate(property, entry, `${path}.${key}`, errors)
        else if (schema.properties && schema.additionalProperties !== true) errors.push(`${path}.${key} is not in the schema`)
      }
    }
  }
  return errors
}

const responseSchema = (operation: string): Schema | undefined => {
  const [method, path] = operation.split(' ')
  const responses = (spec.paths as Record<string, Record<string, any>>)[path]?.[method.toLowerCase()]?.responses
  return responses?.['200']?.content?.['application/json']?.schema
}

const MOVIE = '4f1c2b7a-3d0e-4c6b-9f5a-0e1d2c3b4a59'
const MOVIE_FILE = 'a'.repeat(64)
const HIDDEN = 'b'.repeat(64)
const HIDDEN_FILE = 'c'.repeat(64)
const SHOW = 'd'.repeat(64)
const SEASON = 'e'.repeat(64)
const EPISODE_1 = '1'.repeat(64)
const EPISODE_2 = '2'.repeat(64)

describe('Jellyfin-compatible API', () => {
  let ctx: ServiceTestContext
  let app: ReturnType<typeof buildApp>
  let dataPath: string
  let adminToken: string
  let normalToken: string

  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://localhost/jellyfin${path}`, {
      method,
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: `MediaBrowser Client="Test", Device="cli", DeviceId="test-device", Version="1.0"${token ? `, Token="${token}"` : ''}`,
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }))

  /** Calls a route and checks the response against the operation it serves. */
  const conforming = async (method: string, path: string, token = adminToken, body?: unknown): Promise<any> => {
    const response = await call(method, path, token, body)
    expect(response.status).toBe(200)
    const value = await response.json()
    const url = new URL(path, 'http://localhost')
    const route = jellyfinRoutes().find((entry) => entry.method === method && entry.pattern.test(url.pathname))!
    const schema = responseSchema(route.operation)
    if (schema) expect(validate(schema, value)).toEqual([])
    return value
  }

  const signIn = async (username: string) => {
    const response = await call('POST', '/Users/AuthenticateByName', undefined, { Username: username, Pw: 'password' })
    expect(response.status).toBe(200)
    return ((await response.json()) as { AccessToken: string }).AccessToken
  }

  beforeAll(async () => {
    dataPath = await mkdtemp(join(tmpdir(), 'kinome-jellyfin-'))
    setUserDataPath(dataPath)
    ctx = createServiceTestContext()
    app = buildApp()
    const hash = await bcrypt.hash('password', 1)
    accountRepo.createAccount('admin-1', 'alice', hash, 'admin')
    accountRepo.createAccount('normal-1', 'bob', hash, 'normal')
    ctx.seedEntities([
      { id: 'movie-entity', tmdbId: 101, mediaType: 'movie', title: 'Arrival', year: 2016 },
      { id: 'hidden-entity', tmdbId: 102, mediaType: 'movie', title: 'Hidden Film', year: 2001 },
      { id: 'show-entity', tmdbId: 201, mediaType: 'tv', title: 'Severance', year: 2022 },
      { id: 'season-entity', mediaType: 'season', title: 'Season 1', seasonNumber: 1 },
      { id: 'episode-1-entity', mediaType: 'episode', title: 'Good News About Hell', seasonNumber: 1, episodeNumber: 1 },
      { id: 'episode-2-entity', mediaType: 'episode', title: 'Half Loop', seasonNumber: 1, episodeNumber: 2 }
    ])
    ctx.seedGenres('movie-entity', ['Science Fiction'])
    ctx.seedItems([
      { id: MOVIE, name: 'Arrival (2016)', type: 'folder', entityId: 'movie-entity', path: 'Arrival (2016)' },
      { id: MOVIE_FILE, parentId: MOVIE, name: 'Arrival.mkv', path: 'Arrival (2016)/Arrival.mkv' },
      { id: HIDDEN, name: 'Hidden Film', type: 'folder', entityId: 'hidden-entity', path: 'Hidden Film' },
      { id: HIDDEN_FILE, parentId: HIDDEN, name: 'Hidden.mkv', path: 'Hidden Film/Hidden.mkv' },
      { id: SHOW, name: 'Severance', type: 'folder', entityId: 'show-entity', path: 'Severance' },
      { id: SEASON, parentId: SHOW, name: 'Season 1', type: 'folder', entityId: 'season-entity', path: 'Severance/Season 1' },
      { id: EPISODE_1, parentId: SEASON, name: 'e01.mkv', entityId: 'episode-1-entity', path: 'Severance/Season 1/e01.mkv' },
      { id: EPISODE_2, parentId: SEASON, name: 'e02.mkv', entityId: 'episode-2-entity', path: 'Severance/Season 1/e02.mkv' }
    ])
    adminToken = await signIn('alice')
    normalToken = await signIn('bob')
    // Hide one movie from the normal account.
    const filter = { conditions: [{ field: 'name', op: 'eq', value: 'Hidden Film' }] }
    const rule = await app.handle(new Request('http://localhost/api/accounts/normal-1/filter', {
      method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'deny', filter })
    }))
    expect(rule.status).toBe(200)
  })

  afterAll(async () => {
    ctx.cleanup()
    await rm(dataPath, { recursive: true, force: true })
  })

  it('answers the web client sign-in and browsing sequence within the pinned schema', async () => {
    // Apps such as the official Android app open the server's own web client.
    const start = await call('GET', '/')
    expect(start.headers.get('location')).toBe('http://localhost/jellyfin/web/')
    // The client itself is downloaded separately and may be absent in a fresh clone.
    const page = await call('GET', '/web/')
    if (existsSync(join(import.meta.dir, '../../../vendor/jellyfin-web/index.html'))) expect(await page.text()).toContain('<html')
    else expect(page.status).toBe(404)
    expect((await call('GET', '/web/..%2F..%2F..%2Fpackage.json')).status).toBe(404)
    expect((await call('GET', '/web/%E0%A4%A')).status).toBe(404)
    const info = await conforming('GET', '/System/Info/Public', '')
    expect(info).toMatchObject({ ProductName: 'Jellyfin Server', Version: '12.4.0', StartupWizardCompleted: true })
    const me = await conforming('GET', '/Users/Me')
    expect(me.Policy.IsAdministrator).toBe(true)
    await conforming('GET', `/Users/${me.Id}`)
    const views = await conforming('GET', `/UserViews?userId=${me.Id}`)
    expect(views.Items.map((view: any) => view.CollectionType)).toEqual(['movies', 'tvshows'])

    const movies = await conforming('GET', `/Items?ParentId=${LIBRARIES.movies.id}&Recursive=true&IncludeItemTypes=Movie&Fields=Overview,Genres&SortBy=SortName&SortOrder=Ascending&StartIndex=0&Limit=1`)
    expect(movies.TotalRecordCount).toBe(2)
    expect(movies.Items[0]).toMatchObject({ Name: 'Arrival', Type: 'Movie', Id: MOVIE.replaceAll('-', ''), ProviderIds: { Tmdb: '101' }, Genres: ['Science Fiction'] })
    const series = await conforming('GET', `/Items?ParentId=${LIBRARIES.tvshows.id}&IncludeItemTypes=Series&Fields=Overview`)
    expect(series.Items).toMatchObject([{ Name: 'Severance', Id: SHOW.slice(0, 32), RecursiveItemCount: 2, UserData: { UnplayedItemCount: 2 } }])

    // The web client loads a media source by its ID, so a title's source carries the title's ID.
    const detail = await conforming('GET', `/Items/${toJellyfinId(MOVIE)}?userId=${me.Id}`)
    expect(detail.MediaSources.map((source: { Id: string }) => source.Id)).toEqual([toJellyfinId(MOVIE)])
    // Older clients address items under the user.
    await conforming('GET', `/Users/${me.Id}/Items/${toJellyfinId(EPISODE_1)}`)
    const seasons = await conforming('GET', `/Shows/${SHOW.slice(0, 32)}/Seasons?userId=${me.Id}`)
    expect(seasons.Items).toMatchObject([{ Type: 'Season', IndexNumber: 1, SeriesId: SHOW.slice(0, 32) }])
    const episodes = await conforming('GET', `/Shows/${SHOW.slice(0, 32)}/Episodes?seasonId=${SEASON.slice(0, 32)}&Fields=Overview`)
    expect(episodes.Items.map((episode: any) => [episode.IndexNumber, episode.SeasonId, episode.SeriesName]))
      .toEqual([[1, SEASON.slice(0, 32), 'Severance'], [2, SEASON.slice(0, 32), 'Severance']])

    const latest = await conforming('GET', `/Items/Latest?ParentId=${LIBRARIES.movies.id}&Limit=16`)
    expect(latest.map((item: any) => item.Name).sort()).toEqual(['Arrival', 'Hidden Film'])
    await conforming('GET', '/UserItems/Resume?Limit=12&MediaTypes=Video')
    await conforming('GET', '/Shows/NextUp?Limit=24')
    await conforming('GET', `/Items/${toJellyfinId(EPISODE_1)}/Ancestors`)
    await conforming('GET', `/Genres?ParentId=${LIBRARIES.movies.id}`)
    await conforming('GET', '/Items/Filters2')
    const search = await conforming('GET', '/Search/Hints?searchTerm=Arrival')
    expect(search.SearchHints.map((hint: any) => hint.Name)).toContain('Arrival')

    await conforming('POST', `/DisplayPreferences/usersettings?client=emby`, adminToken, { Id: 'usersettings', SortBy: 'DateCreated', CustomPrefs: { skipForwardLength: '30000' }, Client: 'emby' })
      .catch(() => undefined)
    const preferences = await conforming('GET', `/DisplayPreferences/usersettings?userId=${me.Id}&client=emby`)
    expect(preferences).toMatchObject({ SortBy: 'DateCreated', CustomPrefs: { skipForwardLength: '30000' } })
  })

  it('answers in camelCase only when the first JSON form a client accepts asks for it', async () => {
    const sdk = await call('GET', '/System/Info/Public', undefined, undefined, { Accept: 'application/json,application/json; profile=CamelCase' })
    expect(await sdk.json()).toHaveProperty('ServerName')
    const camel = await call('GET', `/Items?ParentId=${LIBRARIES.movies.id}&Fields=Genres`, adminToken, undefined, { Accept: 'application/json; profile="CamelCase"' })
    const [item] = ((await camel.json()) as { items: unknown[] }).items
    expect(item).toMatchObject({ name: 'Arrival', providerIds: { Tmdb: '101' } })
  })

  it('keeps hidden items out of every route for a restricted account', async () => {
    const hidden = toJellyfinId(HIDDEN)
    const movies = await conforming('GET', `/Items?ParentId=${LIBRARIES.movies.id}&IncludeItemTypes=Movie`, normalToken)
    expect(movies.Items.map((item: any) => item.Name)).toEqual(['Arrival'])
    expect((await call('GET', `/Items/${hidden}`, normalToken)).status).toBe(404)
    expect((await conforming('GET', `/Items?Ids=${hidden}`, normalToken)).Items).toEqual([])
    expect((await conforming('GET', '/Search/Hints?searchTerm=Hidden', normalToken)).SearchHints).toEqual([])
    expect((await conforming('GET', `/Items/Latest?ParentId=${LIBRARIES.movies.id}`, normalToken)).map((item: any) => item.Name)).toEqual(['Arrival'])
    expect((await call('POST', `/Items/${hidden}/PlaybackInfo`, normalToken, {})).status).toBe(404)
    expect((await call('GET', `/Videos/${hidden}/stream?static=true`, normalToken)).status).toBe(404)
    expect((await call('GET', `/Items/${hidden}/Images/Primary`, normalToken)).status).toBe(404)
    expect((await call('GET', `/Items/${hidden}/Images/Primary`)).status).toBe(401)
    expect((await call('GET', '/Items?Recursive=true')).status).toBe(401)
    // Media without credentials needs a prior signed-in playback info request for the item.
    expect((await call('GET', `/Videos/${toJellyfinId(MOVIE)}/stream?static=true`)).status).toBe(401)
  })

  it('signs a device in with Quick Connect once an account approves its code', async () => {
    const waiting = await conforming('POST', '/QuickConnect/Initiate', '')
    expect(waiting.Authenticated).toBe(false)
    expect(waiting.Code).toMatch(/^\d{6}$/)
    expect((await call('POST', '/Users/AuthenticateWithQuickConnect', undefined, { Secret: waiting.Secret })).status).toBe(401)
    expect((await call('POST', '/QuickConnect/Authorize?code=000000x', normalToken)).status).toBe(404)
    // Kinome's own account dialog approves through its API.
    const approve = await app.handle(new Request('http://localhost/api/quick-connect', {
      method: 'POST', headers: { Authorization: `Bearer ${normalToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: waiting.Code })
    }))
    expect(approve.status).toBe(200)
    expect((await conforming('GET', `/QuickConnect/Connect?secret=${waiting.Secret}`, '')).Authenticated).toBe(true)
    const signedIn = await conforming('POST', '/Users/AuthenticateWithQuickConnect', '', { Secret: waiting.Secret })
    expect(signedIn.User.Name).toBe('bob')
    expect((await call('GET', '/Users/Me', signedIn.AccessToken)).status).toBe(200)
    expect((await call('POST', '/Users/AuthenticateWithQuickConnect', undefined, { Secret: waiting.Secret })).status).toBe(401)
  })

  it('lets Seerr create an API key and read it back once', async () => {
    expect((await call('POST', '/Auth/Keys?App=Seerr', adminToken)).status).toBe(204)
    const keys = await conforming('GET', '/Auth/Keys')
    const created = keys.Items.find((key: any) => key.AppName === 'Seerr')
    expect(created.AccessToken).toMatch(/^[0-9a-f]{32}$/)
    expect((await conforming('GET', '/Library/MediaFolders', created.AccessToken)).Items).toHaveLength(2)
    expect((await call('DELETE', `/Auth/Keys/${created.AccessToken}`, adminToken)).status).toBe(204)
    expect((await call('GET', '/Users/Me', created.AccessToken)).status).toBe(401)
  })

  it('scans the paths Sonarr and Radarr report, and only for accounts that may scan', async () => {
    const scan = spyOn(libraryService, 'performScan').mockResolvedValue({ success: true })
    try {
      const updates = { Updates: [{ Path: '/media/Severance', UpdateType: 'Modified' }] }
      expect((await call('POST', '/Library/Media/Updated', normalToken, updates)).status).toBe(403)
      expect((await call('POST', '/Library/Media/Updated', adminToken, updates)).status).toBe(204)
      expect(scan.mock.calls).toEqual([[undefined, { path: '/media/Severance' }]])
    } finally {
      scan.mockRestore()
    }
  })

  it('works through the Jellyfin SDK that clients are built on', async () => {
    const { Jellyfin } = await import('@jellyfin/sdk')
    const { getLibraryApi } = await import('@jellyfin/sdk/lib/utils/api/library-api.js')
    const { getShowApi } = await import('@jellyfin/sdk/lib/utils/api/show-api.js')
    const { getMediaInfoApi } = await import('@jellyfin/sdk/lib/utils/api/media-info-api.js')
    const server = app.listen({ port: 0, hostname: '127.0.0.1' }).server!
    try {
      const jellyfin = new Jellyfin({ clientInfo: { name: 'Kinome test', version: '1.0' }, deviceInfo: { name: 'cli', id: 'sdk-test' } })
      const api = jellyfin.createApi(`http://127.0.0.1:${server.port}/jellyfin`)
      const { data: auth } = await api.authenticateUserByName('alice', 'password')
      expect(auth.User?.Policy?.IsAdministrator).toBe(true)
      const { data: movies } = await getLibraryApi(api).getItems({ parentId: LIBRARIES.movies.id, recursive: true, includeItemTypes: ['Movie'] })
      expect(movies.Items?.map((item) => item.Name)).toEqual(['Arrival', 'Hidden Film'])
      const { data: episodes } = await getShowApi(api).getEpisodes({ seriesId: SHOW.slice(0, 32), seasonId: SEASON.slice(0, 32) })
      expect(episodes.Items?.map((episode) => episode.IndexNumber)).toEqual([1, 2])
      const { data: item } = await getLibraryApi(api).getItem({ itemId: toJellyfinId(MOVIE) })
      expect(item).toMatchObject({ Type: 'Movie', ProductionYear: 2016 })
      // The file is not probed here, so Kinome has nothing to offer the client yet.
      const { data: playback } = await getMediaInfoApi(api).getPostedPlaybackInfo({ itemId: toJellyfinId(MOVIE), playbackInfoDto: {} })
        .catch((error) => ({ data: { status: error.response?.status } }))
      expect(playback).toEqual({ status: 404 })
    } finally {
      server.stop(true)
    }
  })

  it('keeps favourites as each account\'s personal favorite tag', async () => {
    const movie = toJellyfinId(MOVIE)
    const favorite = await call('POST', `/UserFavoriteItems/${movie}`, adminToken)
    expect(((await favorite.json()) as { IsFavorite: boolean }).IsFavorite).toBe(true)
    const tags = await app.handle(new Request(`http://localhost/api/items/${MOVIE}/personal-tags`, { headers: { Authorization: `Bearer ${adminToken}` } }))
    expect(await tags.json()).toEqual({ favorite: 'true' })
    const favorites = `/Items?Recursive=true&IncludeItemTypes=Movie,Series&Filters=IsFavorite`
    expect((await conforming('GET', favorites)).Items.map((item: { Name: string }) => item.Name)).toEqual(['Arrival'])
    expect((await conforming('GET', favorites, normalToken)).Items).toEqual([])
    expect((await conforming('GET', `/Items/${movie}`)).UserData.IsFavorite).toBe(true)
    expect((await conforming('GET', `/Items/${movie}`, normalToken)).UserData.IsFavorite).toBe(false)
    // The account edits the same tags in Kinome.
    const cleared = await app.handle(new Request(`http://localhost/api/items/${MOVIE}/personal-tags`, {
      method: 'PUT', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: { mood: 'rainy' } })
    }))
    expect(cleared.status).toBe(200)
    expect((await conforming('GET', `/Items/${movie}`)).UserData.IsFavorite).toBe(false)
    const hidden = await app.handle(new Request(`http://localhost/api/items/${HIDDEN}/personal-tags`, { headers: { Authorization: `Bearer ${normalToken}` } }))
    expect(hidden.status).toBe(404)
  })

  it('reports progress and completion on the file that plays', async () => {
    const movie = toJellyfinId(MOVIE)
    expect((await call('POST', '/Sessions/Playing/Progress', adminToken, { ItemId: movie, PositionTicks: 0 })).status).toBe(204)
    expect((await call('POST', `/UserPlayedItems/${movie}`, adminToken)).status).toBe(200)
    const item = await conforming('GET', `/Items/${movie}`)
    expect(item.UserData.Played).toBe(true)
    // Watched state lives on the movie's file, and filters follow it.
    const library = `/Items?ParentId=${LIBRARIES.movies.id}&IncludeItemTypes=Movie`
    expect((await conforming('GET', `${library}&IsPlayed=true`)).Items.map((entry: { Name: string }) => entry.Name)).toEqual(['Arrival'])
    expect((await conforming('GET', `${library}&Filters=IsUnplayed`)).Items.map((entry: { Name: string }) => entry.Name)).toEqual(['Hidden Film'])
    expect((await call('DELETE', `/UserPlayedItems/${movie}`, adminToken)).status).toBe(200)
  })

  it('tells an account\'s sockets about its own changes and the items it can see', async () => {
    const sent: any[] = []
    const socket = { id: 'test-socket', send: (text: string) => sent.push(JSON.parse(text)) }
    events.connect(socket, authService.validateToken(normalToken)!)
    try {
      const movie = toJellyfinId(MOVIE)
      expect((await call('POST', `/UserFavoriteItems/${movie}`, normalToken)).status).toBe(200)
      events.itemsChanged([MOVIE, HIDDEN])
      await events.flushEvents()
      const library = sent.find((entry) => entry.MessageType === 'LibraryChanged')
      expect(library.Data.ItemsUpdated).toEqual([movie])
      const user = sent.find((entry) => entry.MessageType === 'UserDataChanged')
      expect(user.Data.UserDataList).toMatchObject([{ ItemId: movie, IsFavorite: true }])
      expect((await call('DELETE', `/UserFavoriteItems/${movie}`, normalToken)).status).toBe(200)
    } finally {
      events.disconnect(socket)
    }
  })

  it('presents tagged virtual folders as libraries, collections and editable playlists', async () => {
    const [LIBRARY, COLLECTION, PLAYLIST] = ['9a', '9b', '9c'].map((prefix) => `${prefix}000000-0000-4000-8000-000000000000`)
    ctx.seedItems([
      { id: LIBRARY, name: 'Science Fiction', isVirtual: 1, virtualType: 'user', filterJson: JSON.stringify({ conditions: [{ field: 'genre', op: 'eq', value: 'Science Fiction' }] }) },
      { id: COLLECTION, name: 'Everything', isVirtual: 1, virtualType: 'user', filterJson: JSON.stringify({ conditions: [{ field: 'year', op: 'gte', value: 1900 }] }) },
      { id: PLAYLIST, name: 'Road Trip', isVirtual: 1, virtualType: 'user', filterJson: JSON.stringify({ conditions: [{ field: 'tags.playlist', op: 'eq', value: 'road trip' }] }) }
    ])
    const tag = ctx.db.prepare('INSERT INTO item_tags (item_id, key, value) VALUES (?, ?, ?)')
    tag.run(LIBRARY, 'jellyfin', 'movies')
    tag.run(PLAYLIST, 'jellyfin', 'playlist')
    // A personal tag makes a folder a collection for its account only.
    ctx.db.run('INSERT INTO account_item_tags (account_id, item_id, key, value) VALUES (?, ?, ?, ?)', ['normal-1', COLLECTION, 'jellyfin', 'collection'])
    try {
      const names = async (token: string) => (await conforming('GET', '/UserViews', token)).Items.map((view: any) => [view.Name, view.CollectionType])
      expect(await names(adminToken)).toEqual([['Science Fiction', 'movies'], ['Playlists', 'playlists']])
      expect(await names(normalToken)).toEqual([['Science Fiction', 'movies'], ['Collections', 'boxsets'], ['Playlists', 'playlists']])
      const library = toJellyfinId(LIBRARY)
      expect((await conforming('GET', `/Items?ParentId=${library}&IncludeItemTypes=Movie&Recursive=true`)).Items.map((item: any) => item.Name)).toEqual(['Arrival'])
      const [collection] = (await conforming('GET', '/Items?IncludeItemTypes=BoxSet&Recursive=true', normalToken)).Items
      expect(collection).toMatchObject({ Name: 'Everything', Type: 'BoxSet' })
      expect((await conforming('GET', `/Items?ParentId=${collection.Id}`, normalToken)).Items.map((item: any) => item.Name)).toEqual(['Arrival', 'Severance'])

      const playlist = toJellyfinId(PLAYLIST)
      const entries = async () => (await conforming('GET', `/Playlists/${playlist}/Items`)).Items.map((item: any) => [item.Name, item.PlaylistItemId])
      expect((await call('POST', `/Playlists/${playlist}/Items?ids=${toJellyfinId(MOVIE)},${toJellyfinId(EPISODE_1)}`, normalToken)).status).toBe(403)
      expect((await call('POST', `/Playlists/${playlist}/Items?ids=${toJellyfinId(MOVIE)},${toJellyfinId(EPISODE_1)}`, adminToken)).status).toBe(204)
      const before = await entries()
      expect(before.map(([name]: string[]) => name).sort()).toEqual(['Arrival', 'Good News About Hell'])
      // Moving the second entry first arranges it before the other.
      expect((await call('POST', `/Playlists/${playlist}/Items/${before[1][1]}/Move/0`, adminToken)).status).toBe(204)
      expect(await entries()).toEqual([before[1], before[0]])
      expect((await call('DELETE', `/Playlists/${playlist}/Items?entryIds=${toJellyfinId(EPISODE_1)}`, adminToken)).status).toBe(204)
      expect((await entries()).map(([name]: string[]) => name)).toEqual(['Arrival'])
      // A playlist that follows any other filter is read-only.
      expect((await call('POST', `/Playlists/${collection.Id}/Items?ids=${toJellyfinId(MOVIE)}`, adminToken)).status).toBe(404)
    } finally {
      ctx.db.run(`DELETE FROM item_tags WHERE key IN ('jellyfin', 'playlist')`)
      ctx.db.run('DELETE FROM account_item_tags WHERE key = ?', ['jellyfin'])
    }
  })

  it('offers files of about the film\'s length as versions and shorter ones as extras', async () => {
    const [VERSION, TRAILER, EXTRAS, MAKING_OF] = ['5', '6', '7', '8'].map((digit) => digit.repeat(64))
    ctx.seedItems([
      { id: VERSION, parentId: MOVIE, name: 'Arrival.uhd.mkv', path: 'Arrival (2016)/Arrival.uhd.mkv' },
      { id: TRAILER, parentId: MOVIE, name: 'Arrival-trailer.mkv', path: 'Arrival (2016)/Arrival-trailer.mkv' },
      { id: EXTRAS, parentId: MOVIE, name: 'Extras', type: 'folder', path: 'Arrival (2016)/Extras' },
      { id: MAKING_OF, parentId: EXTRAS, name: 'Making of.mkv', path: 'Arrival (2016)/Extras/Making of.mkv' }
    ])
    for (const [id, seconds] of [[MOVIE_FILE, 6960], [VERSION, 6900], [TRAILER, 150], [MAKING_OF, 1200]] as const) {
      ctx.db.run('INSERT INTO local_media (location_id, container, duration_seconds, failures) VALUES (?, ?, ?, 0)', [`location:${id}`, 'matroska', seconds])
      ctx.db.run(`INSERT INTO local_media_tracks (location_id, stream_index, kind, codec, width, height, is_default, forced, hearing_impaired)
        VALUES (?, 0, 'video', 'h264', 1920, 1080, 1, 0, 0)`, [`location:${id}`])
    }
    const movie = toJellyfinId(MOVIE)
    const item = await conforming('GET', `/Items/${movie}`)
    expect(item).toMatchObject({ MediaSourceCount: 2, LocalTrailerCount: 1, SpecialFeatureCount: 1 })
    expect(item.MediaSources.map((source: { Id: string }) => source.Id)).toEqual([movie, toJellyfinId(VERSION)])
    expect((await conforming('GET', `/Items/${movie}/LocalTrailers`)).map((extra: any) => [extra.Type, extra.ExtraType])).toEqual([['Trailer', 'Trailer']])
    const [making] = await conforming('GET', `/Items/${movie}/SpecialFeatures`)
    expect(making).toMatchObject({ Name: 'Making of.mkv', Type: 'Video', ExtraType: 'BehindTheScenes', ParentId: movie })
    // An extra opens by its own ID.
    expect((await conforming('GET', `/Items/${making.Id}`)).ExtraType).toBe('BehindTheScenes')
  })
})

describe('Jellyfin playback negotiation', () => {
  const media = {
    container: 'matroska,webm', bitrate: 8_000_000, tracks: [
      { index: 0, kind: 'video' as const, codec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le', height: 2160, width: 3840, default: true, forced: false, hearingImpaired: false },
      { index: 1, kind: 'audio' as const, codec: 'dts', channels: 6, default: true, forced: false, hearingImpaired: false },
      { index: 2, kind: 'audio' as const, codec: 'aac', channels: 2, default: false, forced: false, hearingImpaired: false }
    ]
  }
  const info = { qualities: ['original', 'remux', '1080p', '720p', '480p'] as any, audioConversion: true }
  const tv = {
    DirectPlayProfiles: [{ Type: 'Video' as const, Container: 'mkv,mp4', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,dts' }],
    TranscodingProfiles: [{ Type: 'Video' as const, Container: 'ts', Protocol: 'hls' as const, VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3', MaxAudioChannels: '6' } as any]
  }

  it('plays a supported file directly', () => {
    expect(negotiate(tv, info, media, {})).toMatchObject({ directPlay: true })
  })

  it('converts only the audio when the selected soundtrack is unsupported for streaming', () => {
    expect(negotiate({ ...tv, DirectPlayProfiles: [{ ...tv.DirectPlayProfiles[0], AudioCodec: 'aac' }] }, info, media, {}))
      .toMatchObject({ directPlay: false, quality: 'audio', reasons: ['AudioCodecNotSupported'] })
    expect(negotiate({ ...tv, DirectPlayProfiles: [{ ...tv.DirectPlayProfiles[0], AudioCodec: 'aac' }] }, info, media, { audioIndex: 2 }))
      .toMatchObject({ directPlay: true })
  })

  it('transcodes when a codec condition fails, keeping ten bits for a client that takes HEVC', () => {
    const profile = { ...tv, CodecProfiles: [{ Type: 'Video' as const, Codec: 'hevc', Conditions: [{ Condition: 'LessThanEqual' as const, Property: 'VideoBitDepth' as const, Value: '8', IsRequired: true }] }] }
    expect(negotiate(profile, info, media, {})).toMatchObject({ directPlay: false, quality: '1080p', videoCodec: 'hevc', sound: undefined, reasons: ['VideoBitDepthNotSupported'] })
    expect(negotiate(profile, info, media, { audioIndex: 2 })).toMatchObject({ quality: '1080p', sound: 'copy' })
  })

  it('picks the rendition that fits the bitrate limit', () => {
    expect(negotiate(tv, info, media, { maxBitrate: 3_000_000 })).toMatchObject({ directPlay: false, quality: '480p' })
  })
})
