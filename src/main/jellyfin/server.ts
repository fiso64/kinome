/**
 * Server identity, sign-in, users and client settings for Jellyfin clients.
 */
import { randomBytes } from 'node:crypto'
import type { components } from './openapi'
import type { Account } from '@shared/types'
import type { PlaybackPreferences, SubtitleMode } from '@shared/web-playback'
import * as authService from '../services/auth.service'
import * as settingsService from '../services/settings.service'
import * as accountRepo from '../database/repositories/account.repo'
import * as displayPreferencesRepo from './display-preferences.repo'
import { getPlaybackPreferences, savePlaybackPreferences } from '../services/web-playback.service'
import { accountToJellyfinId, resolveAccountId } from './ids'
import { JellyfinError, field, serverName, forbidden, json, notFound, route, type JellyfinRequest } from './request'
import { JELLYFIN_VERSION } from './web'
import { sessionDto } from './sessions'


type UserDto = components['schemas']['UserDto']

/**
 * Jellyfin's own Chromecast receiver, hosted by the Jellyfin project, which
 * Jellyfin apps cast with. It plays through this API, so the cast device needs
 * to reach Kinome at the address the app uses.
 */
const CAST_RECEIVER = { Id: 'F007D354', Name: 'Stable' }

const SUBTITLE_MODES: Record<SubtitleMode, NonNullable<components['schemas']['UserConfiguration']['SubtitleMode']>> = {
  default: 'Default', forced: 'OnlyForced', off: 'None'
}

function account(request: JellyfinRequest): Account {
  const found = accountRepo.getAccountById(request.session!.accountId)
  if (!found) throw new JellyfinError(401, 'Unauthorized')
  return found
}

export function userDto(user: Account, preferences = getPlaybackPreferences(user.id)): UserDto {
  const admin = user.role === 'admin'
  return {
    Name: user.username,
    ServerId: settingsService.getServerId(),
    Id: accountToJellyfinId(user.id),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Configuration: {
      AudioLanguagePreference: preferences.audioLanguage?.split(',')[0]?.trim() ?? undefined,
      PlayDefaultAudioTrack: !preferences.audioLanguage,
      SubtitleLanguagePreference: preferences.subtitleLanguage?.split(',')[0]?.trim() ?? '',
      SubtitleMode: SUBTITLE_MODES[preferences.subtitles],
      DisplayMissingEpisodes: false, GroupedFolders: [], DisplayCollectionsView: false, EnableLocalPassword: false,
      OrderedViews: [], LatestItemsExcludes: [], MyMediaExcludes: [], HidePlayedInLatest: true,
      RememberAudioSelections: true, RememberSubtitleSelections: true, EnableNextEpisodeAutoPlay: true,
      CastReceiverId: CAST_RECEIVER.Id
    },
    Policy: {
      IsAdministrator: admin, IsHidden: false, IsDisabled: false, EnableCollectionManagement: false,
      EnableSubtitleManagement: false, EnableLyricManagement: false, BlockedTags: [], AllowedTags: [],
      EnableUserPreferenceAccess: true, AccessSchedules: [], BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false, EnableSharedDeviceControl: false, EnableRemoteAccess: true,
      EnableLiveTvManagement: false, EnableLiveTvAccess: false, EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: true, EnableVideoPlaybackTranscoding: true, EnablePlaybackRemuxing: true,
      ForceRemoteSourceTranscoding: false, EnableContentDeletion: false, EnableContentDeletionFromFolders: [],
      EnableContentDownloading: true, EnableSyncTranscoding: false, EnableMediaConversion: false,
      EnabledDevices: [], EnableAllDevices: true, EnabledChannels: [], EnableAllChannels: false, EnabledFolders: [],
      EnableAllFolders: true, InvalidLoginAttemptCount: 0, LoginAttemptsBeforeLockout: -1, MaxActiveSessions: 0,
      EnablePublicSharing: false, BlockedMediaFolders: [], BlockedChannels: [], RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Kinome', PasswordResetProviderId: 'Kinome', SyncPlayAccess: 'None'
    }
  }
}

function publicInfo(request: JellyfinRequest) {
  return {
    LocalAddress: request.baseUrl, ServerName: serverName(request.settings), Version: JELLYFIN_VERSION, ProductName: 'Jellyfin Server',
    OperatingSystem: '', Id: settingsService.getServerId(), StartupWizardCompleted: true
  }
}

async function authenticate(request: JellyfinRequest, ip: string) {
  const limit = authService.checkLoginRateLimit(ip)
  if (!limit.allowed) throw new JellyfinError(429, `Too many attempts. Please wait ${limit.waitTime} minutes.`)
  const body = await request.body()
  const username = field<string>(body, 'Username')
  const password = field<string>(body, 'Pw') ?? field<string>(body, 'Password')
  const result = username && password ? await authService.login(username, password, {
    ...request.device, client: request.device.client ?? 'Jellyfin client'
  }) : null
  if (!result) {
    authService.recordFailedLogin(ip)
    throw new JellyfinError(401, 'Invalid username or password.')
  }
  authService.resetLoginRateLimit(ip)
  console.info('[Jellyfin] Signed in', { account: result.account.username, client: request.device.client, device: request.device.deviceName })
  const signedIn = { ...request, session: authService.validateToken(result.token) }
  return json(request, {
    User: userDto(result.account), SessionInfo: await sessionDto(signedIn, undefined),
    AccessToken: result.token, ServerId: settingsService.getServerId()
  })
}

/** A user ID in a path may name only the signed-in account, unless the caller manages accounts. */
function requestedUser(request: JellyfinRequest, value = request.params.userId): Account {
  const accountId = resolveAccountId(value)
  if (!accountId) throw notFound()
  if (accountId !== request.session!.accountId && !request.session!.capabilities.has('manageAccounts')) throw forbidden()
  return accountRepo.getAccountById(accountId) ?? (() => { throw notFound() })()
}

async function saveConfiguration(request: JellyfinRequest, user: Account) {
  const body = await request.body()
  const current = getPlaybackPreferences(user.id)
  const audio = field<string>(body, 'AudioLanguagePreference')
  const subtitle = field<string>(body, 'SubtitleLanguagePreference')
  const mode = field<string>(body, 'SubtitleMode')
  const subtitles = mode === 'None' ? 'off' : mode === 'OnlyForced' ? 'forced' : mode ? 'default' : current.subtitles
  const next: PlaybackPreferences = {
    audioLanguage: audio === undefined ? current.audioLanguage : audio || null,
    subtitleLanguage: subtitle === undefined ? current.subtitleLanguage : subtitle || null,
    subtitles
  }
  // Clients may send language names or codes Kinome does not accept. Keep the current choice then.
  if (!savePlaybackPreferences(user.id, next)) savePlaybackPreferences(user.id, { ...current, subtitles })
}

// API keys are stored hashed. A key created through this API can be read back
// once by its account for a short time, which is how Seerr retrieves it.
const REVEAL_MS = 5 * 60 * 1000
const revealed = new Map<string, { token: string; accountId: string; at: number }>()

function listKeys(request: JellyfinRequest) {
  const now = Date.now()
  for (const [id, entry] of revealed) if (now - entry.at > REVEAL_MS) revealed.delete(id)
  const keys = authService.listApiKeys(request.session!.accountId)
  return json(request, {
    Items: keys.map((key) => ({
      Id: 0, AccessToken: revealed.get(key.id)?.token ?? '', DeviceId: '', AppName: key.name, AppVersion: '',
      DeviceName: '', UserId: accountToJellyfinId(request.session!.accountId), IsActive: true,
      DateCreated: new Date(key.createdAt).toISOString(), DateLastActivity: new Date(key.lastUsedAt).toISOString(), UserName: ''
    })),
    TotalRecordCount: keys.length, StartIndex: 0
  })
}

function createKey(request: JellyfinRequest) {
  const name = request.query.get('app')
  if (!name) throw new JellyfinError(400, 'App name is required.')
  const key = authService.createApiKey(request.session!.accountId, name)
  revealed.set(key.id, { token: key.token, accountId: request.session!.accountId, at: Date.now() })
  return undefined
}

function revokeKey(request: JellyfinRequest) {
  const session = authService.validateToken(request.params.key)
  if (session?.kind === 'api_key' && session.accountId === request.session!.accountId) {
    authService.revokeApiKey(session.accountId, session.tokenId)
  }
  return undefined
}

function displayPreferences(request: JellyfinRequest) {
  const client = request.query.get('client') ?? 'emby'
  const stored = displayPreferencesRepo.read(request.session!.accountId, client, request.params.displayPreferencesId)
  // The stored settings are returned as sent, over defaults for any field a client left out.
  return json(request, {
    Id: request.params.displayPreferencesId, SortBy: 'SortName', RememberIndexing: false, PrimaryImageHeight: 250,
    PrimaryImageWidth: 250, CustomPrefs: {}, ScrollDirection: 'Horizontal', ShowBackdrop: true, RememberSorting: false,
    SortOrder: 'Ascending', ShowSidebar: false, Client: client, ...stored
  })
}

async function saveDisplayPreferences(request: JellyfinRequest) {
  const body = await request.body()
  if (!body || typeof body !== 'object') throw new JellyfinError(400, 'Display preferences are required.')
  const client = request.query.get('client') ?? 'emby'
  displayPreferencesRepo.write(request.session!.accountId, client, request.params.displayPreferencesId, body)
  return undefined
}

const CULTURES = [
  ['English', 'en', 'eng'], ['German', 'de', 'ger'], ['French', 'fr', 'fre'], ['Spanish', 'es', 'spa'], ['Italian', 'it', 'ita'],
  ['Portuguese', 'pt', 'por'], ['Dutch', 'nl', 'dut'], ['Swedish', 'sv', 'swe'], ['Norwegian', 'no', 'nor'], ['Danish', 'da', 'dan'],
  ['Finnish', 'fi', 'fin'], ['Polish', 'pl', 'pol'], ['Czech', 'cs', 'cze'], ['Hungarian', 'hu', 'hun'], ['Greek', 'el', 'gre'],
  ['Turkish', 'tr', 'tur'], ['Russian', 'ru', 'rus'], ['Ukrainian', 'uk', 'ukr'], ['Arabic', 'ar', 'ara'], ['Hebrew', 'he', 'heb'],
  ['Hindi', 'hi', 'hin'], ['Japanese', 'ja', 'jpn'], ['Korean', 'ko', 'kor'], ['Chinese', 'zh', 'chi'], ['Thai', 'th', 'tha'],
  ['Vietnamese', 'vi', 'vie'], ['Indonesian', 'id', 'ind']
].map(([name, two, three]) => ({ Name: name, DisplayName: name, TwoLetterISOLanguageName: two, ThreeLetterISOLanguageName: three, ThreeLetterISOLanguageNames: [three] }))

function quickConnectResult(entry: ReturnType<typeof authService.initiateQuickConnect>) {
  return {
    Authenticated: !!entry.accountId, Secret: entry.secret, Code: entry.code, DeviceId: entry.device.deviceId ?? '',
    DeviceName: entry.device.deviceName ?? '', AppName: entry.device.client ?? '', AppVersion: entry.device.version ?? '',
    DateAdded: new Date(entry.createdAt).toISOString()
  }
}

const emptyResult = (request: JellyfinRequest) => json(request, { Items: [], TotalRecordCount: 0, StartIndex: 0 })

export function serverRoutes(requestIp: (request: Request) => string) {
  return [
    route('GET', '/System/Info/Public', (request) => json(request, publicInfo(request)), { public: true }),
    route('GET', '/System/Info', (request) => json(request, {
      ...publicInfo(request), OperatingSystemDisplayName: '', HasPendingRestart: false, IsShuttingDown: false,
      SupportsLibraryMonitor: true, WebSocketPortNumber: Number(request.url.port) || undefined, CompletedInstallations: [],
      CanSelfRestart: false, CanLaunchWebBrowser: false, CastReceiverApplications: [CAST_RECEIVER], HasUpdateAvailable: false,
      EncoderLocation: 'System', SystemArchitecture: 'X64'
    })),
    route('GET', '/System/Ping', () => new Response('"Jellyfin Server"', { headers: { 'Content-Type': 'application/json' } }), { public: true }),
    route('POST', '/System/Ping', () => new Response('"Jellyfin Server"', { headers: { 'Content-Type': 'application/json' } }), { public: true }),
    route('GET', '/System/Endpoint', (request) => json(request, { IsLocal: false, IsInNetwork: true })),
    // Sonarr and Radarr test the connection with this request.
    route('GET', '/System/Configuration', (request) => json(request, {
      ServerName: serverName(request.settings), IsStartupWizardCompleted: true, EnableMetrics: false, QuickConnectAvailable: true,
      CastReceiverApplications: [CAST_RECEIVER],
      PreferredMetadataLanguage: 'en', MetadataCountryCode: 'US', MinResumePct: 5, MaxResumePct: 90, MinResumeDurationSeconds: 300
    })),
    route('GET', '/Branding/Configuration', (request) => json(request, { LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false }), { public: true }),
    route('GET', '/Branding/Css', () => new Response('', { headers: { 'Content-Type': 'text/css' } }), { public: true }),
    route('GET', '/Branding/Css.css', () => new Response('', { headers: { 'Content-Type': 'text/css' } }), { public: true }),
    route('GET', '/QuickConnect/Enabled', (request) => json(request, true), { public: true }),
    route('POST', '/QuickConnect/Initiate', (request) => json(request, quickConnectResult(authService.initiateQuickConnect({
      ...request.device, client: request.device.client ?? 'Jellyfin client'
    }))), { public: true }),
    route('GET', '/QuickConnect/Connect', (request) => {
      const entry = authService.getQuickConnect(request.query.get('secret') ?? '')
      if (!entry) throw notFound()
      return json(request, quickConnectResult(entry))
    }, { public: true }),
    route('POST', '/QuickConnect/Authorize', (request) => {
      const code = request.query.get('code') ?? ''
      if (!authService.authorizeQuickConnect(request.session!.accountId, code)) throw notFound()
      console.info('[Jellyfin] Quick Connect approved', { account: request.session!.accountId })
      return json(request, true)
    }),
    route('POST', '/Users/AuthenticateWithQuickConnect', async (request) => {
      const result = authService.completeQuickConnect(field<string>(await request.body(), 'Secret') ?? '')
      if (!result) throw new JellyfinError(401, 'The Quick Connect request was not approved.')
      console.info('[Jellyfin] Signed in with Quick Connect', { account: result.account.username, client: request.device.client })
      const signedIn = { ...request, session: authService.validateToken(result.token) }
      return json(request, {
        User: userDto(result.account), SessionInfo: await sessionDto(signedIn, undefined),
        AccessToken: result.token, ServerId: settingsService.getServerId()
      })
    }, { public: true }),
    route('GET', '/Users/Public', (request) => json(request, accountRepo.getAllAccounts().map((user) => ({
      Name: user.username, Id: accountToJellyfinId(user.id), ServerId: settingsService.getServerId(),
      HasPassword: true, HasConfiguredPassword: true, HasConfiguredEasyPassword: false, EnableAutoLogin: false
    }))), { public: true }),
    route('POST', '/Users/AuthenticateByName', (request) => authenticate(request, requestIp(request.request)), { public: true }),
    route('GET', '/Users/Me', (request) => json(request, userDto(account(request)))),
    route('GET', '/Users', (request) => json(request, request.session!.capabilities.has('manageAccounts')
      ? accountRepo.getAllAccounts().map((user) => userDto(user)) : [userDto(account(request))])),
    route('GET', '/Users/{userId}', (request) => json(request, userDto(requestedUser(request)))),
    route('POST', '/Users/Configuration', async (request) => {
      await saveConfiguration(request, requestedUser(request, request.query.get('userId') ?? accountToJellyfinId(request.session!.accountId)))
    }),
    route('POST', '/Users/Configuration', async (request) => { await saveConfiguration(request, requestedUser(request)) }, { alias: '/Users/{userId}/Configuration' }),
    route('POST', '/Sessions/Logout', (request) => { if (request.token) authService.logout(request.token) }),
    route('GET', '/DisplayPreferences/{displayPreferencesId}', displayPreferences),
    route('POST', '/DisplayPreferences/{displayPreferencesId}', saveDisplayPreferences),
    route('GET', '/Auth/Keys', listKeys),
    route('POST', '/Auth/Keys', createKey),
    route('DELETE', '/Auth/Keys/{key}', revokeKey),
    route('GET', '/Localization/Cultures', (request) => json(request, CULTURES)),
    route('GET', '/Localization/Countries', (request) => json(request, [])),
    route('GET', '/Localization/ParentalRatings', (request) => json(request, [])),
    route('GET', '/Localization/Options', (request) => json(request, [{ Name: 'English', Value: 'en-US' }])),
    route('GET', '/Playback/BitrateTest', (request) => {
      const size = Math.min(Math.max(request.query.int('size') ?? 102_400, 0), 10_000_000)
      return new Response(randomBytes(size), { headers: { 'Content-Type': 'application/octet-stream' } })
    }),
    route('POST', '/ClientLog/Document', async (request) => {
      const text = (await request.request.text()).slice(0, 4096)
      console.debug('[Jellyfin] Client log', { client: request.device.client, device: request.device.deviceName, text })
      return json(request, { FileName: 'client.log' })
    }),
    // Features Kinome does not have answer as empty or disabled.
    route('GET', '/SyncPlay/List', (request) => json(request, [])),
    route('GET', '/LiveTv/Info', (request) => json(request, { Services: [], IsEnabled: false, EnabledUsers: [] })),
    route('GET', '/LiveTv/Channels', emptyResult),
    route('GET', '/LiveTv/Programs/Recommended', emptyResult),
    route('GET', '/LiveTv/Programs', emptyResult),
    route('POST', '/LiveTv/Programs', emptyResult),
    route('GET', '/Artists', emptyResult),
    route('GET', '/Artists/AlbumArtists', emptyResult),
    route('GET', '/MusicGenres', emptyResult),
    route('GET', '/LiveTv/Recordings', emptyResult),
    route('GET', '/LiveTv/Timers', emptyResult),
    route('GET', '/LiveTv/SeriesTimers', emptyResult),
    route('GET', '/Plugins', (request) => json(request, [])),
    route('GET', '/Packages', (request) => json(request, [])),
    route('GET', '/ScheduledTasks', (request) => json(request, [])),
    route('GET', '/Devices', emptyResult),
    route('GET', '/Collections', emptyResult),
    route('GET', '/Items/{itemId}/Collections', (request) => json(request, [])),
    route('GET', '/web/ConfigurationPages', (request) => json(request, [])),
    route('GET', '/UserImage', () => { throw notFound() }),
  ]
}
