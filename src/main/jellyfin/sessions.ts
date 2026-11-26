/**
 * Signed-in devices and remote control. Each sign-in is one device's session,
 * named by its token. A device's socket, the capabilities it reports and what
 * it plays are kept in memory, and /Sessions lists an account's own devices.
 * Commands from one of them reach another of the same account over its socket.
 */
import type { components } from './openapi'
import type { SessionData } from '../services/auth.service'
import type { AuthTokenDevice } from '../database/repositories/auth-token.repo'
import * as accountRepo from '../database/repositories/account.repo'
import * as settingsService from '../services/settings.service'
import { accountToJellyfinId, resolveItemId } from './ids'
import { dtoOptions, findItems, relate, toDto } from './items'
import { field, json, notFound, route, type JellyfinRequest } from './request'

type SessionInfoDto = components['schemas']['SessionInfoDto']

export interface EventSocket {
  id: string
  send(message: string): void
}

interface Playing {
  itemId: string
  positionTicks: number
  isPaused: boolean
  isMuted: boolean
  volumeLevel?: number
  mediaSourceId?: string
  audioStreamIndex?: number
  subtitleStreamIndex?: number
  playMethod?: string
}

interface DeviceSession {
  /** The sign-in's token ID, which also names the session to clients. */
  id: string
  session: SessionData
  device: AuthTokenDevice
  playableMediaTypes: NonNullable<SessionInfoDto['PlayableMediaTypes']>
  supportedCommands: NonNullable<SessionInfoDto['SupportedCommands']>
  supportsMediaControl: boolean
  playing?: Playing
  lastActivity: number
  sockets: Map<string, EventSocket>
}

// A device without a socket counts as present for this long after its last request, as in Jellyfin.
const ACTIVE_MS = 10 * 60 * 1000
const sessions = new Map<string, DeviceSession>()

function entry(session: SessionData): DeviceSession {
  let found = sessions.get(session.tokenId)
  if (!found) {
    const now = Date.now()
    for (const [id, old] of sessions) if (!old.sockets.size && now - old.lastActivity > ACTIVE_MS) sessions.delete(id)
    found = {
      id: session.tokenId, session, device: {}, playableMediaTypes: [], supportedCommands: [], supportsMediaControl: false,
      lastActivity: now, sockets: new Map()
    }
    sessions.set(session.tokenId, found)
  }
  return found
}

/** Records a signed-in device's request. API keys belong to integrations, not devices. */
export function touch(session: SessionData, device: AuthTokenDevice): void {
  if (session.kind !== 'session') return
  const found = entry(session)
  found.lastActivity = Date.now()
  if (device.deviceId) found.device = device
}

export function connect(socket: EventSocket, session: SessionData): void {
  entry(session).sockets.set(socket.id, socket)
}

export function disconnect(socket: EventSocket): void {
  for (const found of sessions.values()) found.sockets.delete(socket.id)
}

/** Every open socket with the sign-in it belongs to. */
export function connectedSockets(): { socket: EventSocket; session: SessionData }[] {
  return [...sessions.values()].flatMap((found) => [...found.sockets.values()].map((socket) => ({ socket, session: found.session })))
}

export function socketMessage(type: string, data: unknown): string {
  return JSON.stringify({ MessageType: type, MessageId: crypto.randomUUID().replaceAll('-', ''), Data: data })
}

async function capabilities(request: JellyfinRequest) {
  const found = entry(request.session!)
  const body = request.url.pathname.toLowerCase().endsWith('/full') ? await request.body() : undefined
  const value = <T>(name: string): T | undefined => field<T>(body, name) ?? undefined
  // Clients name their own media types and commands, which are passed on as they sent them.
  const list = <T>(name: string) => (value<string[]>(name) ?? request.query.list(name)) as T
  found.playableMediaTypes = list('PlayableMediaTypes')
  found.supportedCommands = list('SupportedCommands')
  found.supportsMediaControl = value<boolean>('SupportsMediaControl') ?? request.query.bool('supportsMediaControl') ?? false
  return undefined
}

/** Keeps what a device reports playing, for remote controls that show it. */
export function reportPlayback(request: JellyfinRequest, report: Record<string, unknown> | undefined, stopped: boolean): void {
  if (request.session?.kind !== 'session') return
  const found = entry(request.session)
  found.lastActivity = Date.now()
  const itemId = resolveItemId(field<string>(report, 'ItemId'))
  if (stopped || !itemId) {
    found.playing = undefined
    return
  }
  const number = (name: string) => {
    const value = Number(field(report, name))
    return Number.isFinite(value) ? value : undefined
  }
  found.playing = {
    itemId, positionTicks: number('PositionTicks') ?? 0, isPaused: !!field(report, 'IsPaused'), isMuted: !!field(report, 'IsMuted'),
    volumeLevel: number('VolumeLevel'), mediaSourceId: field<string>(report, 'MediaSourceId'),
    audioStreamIndex: number('AudioStreamIndex'), subtitleStreamIndex: number('SubtitleStreamIndex'),
    playMethod: field<string>(report, 'PlayMethod')
  }
}

/** A session as Jellyfin describes it. The requesting device's own session is described from its request. */
export async function sessionDto(request: JellyfinRequest, found: DeviceSession | undefined): Promise<SessionInfoDto> {
  const session = found?.session ?? request.session
  const user = session ? accountRepo.getAccountById(session.accountId) : undefined
  const device = found?.device.deviceId ? found.device : request.device
  const playing = found?.playing
  const item = playing ? findItems({ where: { id: playing.itemId } })[0] : undefined
  const nowPlaying = item ? toDto(item, await relate([item], request), dtoOptions(request.query)) : undefined
  const remote = !!found?.sockets.size
  return {
    Id: found?.id ?? session?.tokenId ?? '', UserId: user ? accountToJellyfinId(user.id) : undefined, UserName: user?.username,
    Client: device.client, DeviceId: device.deviceId, DeviceName: device.deviceName, ApplicationVersion: device.version,
    IsActive: true, LastActivityDate: new Date(found?.lastActivity ?? Date.now()).toISOString(),
    LastPlaybackCheckIn: new Date(0).toISOString(), ServerId: settingsService.getServerId(),
    PlayableMediaTypes: found?.playableMediaTypes ?? [], SupportedCommands: found?.supportedCommands ?? [],
    SupportsMediaControl: remote && !!found?.supportsMediaControl, SupportsRemoteControl: remote,
    HasCustomDeviceName: false, NowPlayingQueue: [],
    ...(nowPlaying && playing ? {
      NowPlayingItem: nowPlaying,
      PlayState: {
        PositionTicks: playing.positionTicks, CanSeek: true, IsPaused: playing.isPaused, IsMuted: playing.isMuted,
        VolumeLevel: playing.volumeLevel, AudioStreamIndex: playing.audioStreamIndex, SubtitleStreamIndex: playing.subtitleStreamIndex,
        MediaSourceId: playing.mediaSourceId, PlayMethod: playing.playMethod as never, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default'
      }
    } : {})
  }
}

/** The account's devices that are connected or were active lately, the requesting one included. */
async function listSessions(request: JellyfinRequest) {
  const accountId = request.session!.accountId
  const within = (request.query.int('activeWithinSeconds') ?? ACTIVE_MS / 1000) * 1000
  const now = Date.now()
  const own = [...sessions.values()].filter((found) => found.session.accountId === accountId &&
    (found.sockets.size || now - found.lastActivity <= within || found.id === request.session!.tokenId))
  const deviceId = request.query.get('deviceId')
  const shown = deviceId ? own.filter((found) => found.device.deviceId === deviceId) : own
  return json(request, await Promise.all(shown.map((found) => sessionDto(request, found))))
}

/** Sends a command to another connected device of the same account. */
function command(request: JellyfinRequest, type: string, data: Record<string, unknown>) {
  const target = sessions.get(request.params.sessionId)
  if (!target || target.session.accountId !== request.session!.accountId || !target.sockets.size) throw notFound()
  const text = socketMessage(type, { ...data, ControllingUserId: accountToJellyfinId(request.session!.accountId) })
  for (const socket of target.sockets.values()) socket.send(text)
  console.debug('[Jellyfin] Remote command', { type, name: data.Name ?? data.Command ?? data.PlayCommand, from: request.device.client, to: target.device.client })
  return undefined
}

function generalCommand(request: JellyfinRequest, name: string, args: Record<string, unknown> = {}) {
  return command(request, 'GeneralCommand', { Name: name, Arguments: args })
}

export const sessionRoutes = [
  route('GET', '/Sessions', listSessions),
  route('POST', '/Sessions/Capabilities', capabilities),
  route('POST', '/Sessions/Capabilities/Full', capabilities),
  route('POST', '/Sessions/{sessionId}/Playing', (request) => command(request, 'Play', {
    ItemIds: request.query.list('itemIds'), PlayCommand: request.query.get('playCommand') ?? 'PlayNow',
    StartPositionTicks: request.query.int('startPositionTicks'), MediaSourceId: request.query.get('mediaSourceId'),
    AudioStreamIndex: request.query.int('audioStreamIndex'), SubtitleStreamIndex: request.query.int('subtitleStreamIndex'),
    StartIndex: request.query.int('startIndex')
  })),
  route('POST', '/Sessions/{sessionId}/Playing/{command}', (request) => command(request, 'Playstate', {
    Command: request.params.command, SeekPositionTicks: request.query.int('seekPositionTicks')
  })),
  route('POST', '/Sessions/{sessionId}/Command', async (request) => {
    const body = await request.body()
    const name = field<string>(body, 'Name')
    if (!name) throw notFound()
    return generalCommand(request, name, field<Record<string, unknown>>(body, 'Arguments') ?? {})
  }),
  route('POST', '/Sessions/{sessionId}/Command/{command}', (request) => generalCommand(request, request.params.command)),
  route('POST', '/Sessions/{sessionId}/System/{command}', (request) => generalCommand(request, request.params.command)),
  route('POST', '/Sessions/{sessionId}/Message', async (request) => {
    const body = await request.body()
    return generalCommand(request, 'DisplayMessage', {
      Header: field<string>(body, 'Header') ?? '', Text: field<string>(body, 'Text') ?? '', TimeoutMs: field<number>(body, 'TimeoutMs')
    })
  }),
  route('POST', '/Sessions/{sessionId}/Viewing', (request) => generalCommand(request, 'DisplayContent', {
    ItemId: request.query.get('itemId'), ItemName: request.query.get('itemName'), ItemType: request.query.get('itemType')
  }))
]
