/**
 * LAN discovery. Jellyfin apps broadcast "who is JellyfinServer?" to UDP port
 * 7359 and list the servers that answer with their address, ID and name. On
 * unless the jellyfinDiscovery setting, or the Jellyfin API as a whole, is off.
 */
import os from 'node:os'
import type { Settings } from '@shared/types'
import * as settingsService from '../services/settings.service'
import { JELLYFIN_BASE, serverName } from './request'

export const DISCOVERY_PORT = 7359
const QUESTION = 'who is jellyfinserver?'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface Listening {
  hostname: string
  port: number
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0
}

/** The server's IPv4 address on the network the asking device is on. */
function localAddressFacing(sender: string): string | undefined {
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal) as os.NetworkInterfaceInfoIPv4[]
  const asking = ipv4Number(sender.replace(/^::ffff:/, ''))
  return (addresses.find((entry) => {
    const mask = ipv4Number(entry.netmask)
    return (ipv4Number(entry.address) & mask) === (asking & mask)
  }) ?? addresses[0])?.address
}

/**
 * The answer to a discovery message, or undefined when there is nothing to
 * say: a different message, or a server only reachable through an address it
 * was not told about.
 */
export function discoveryReply(message: string, sender: string, settings: Settings, listening: Listening): string | undefined {
  if (message.trim().toLowerCase() !== QUESTION) return undefined
  const published = settings.jellyfinPublishedUrl?.trim().replace(/\/+$/, '')
  let base = published
  if (!base) {
    if (LOOPBACK.has(listening.hostname)) return undefined
    const address = localAddressFacing(sender)
    if (!address) return undefined
    base = `http://${address}:${listening.port}`
  }
  return JSON.stringify({ Address: base + JELLYFIN_BASE, Id: settingsService.getServerId(), Name: serverName(settings), EndpointAddress: null })
}

let socket: Bun.udp.Socket<'buffer'> | undefined
let listening: Listening | undefined

/** Starts or stops answering to match the settings. Called at startup and when settings change. */
export async function applyDiscovery(server?: Listening): Promise<void> {
  listening = server ?? listening
  const settings = await settingsService.readSettings()
  const enabled = settings.jellyfinEnabled !== false && settings.jellyfinDiscovery !== false && !!listening
  if (enabled && !socket) {
    try {
      socket = await Bun.udpSocket({
        hostname: '0.0.0.0', port: DISCOVERY_PORT,
        socket: {
          data(udp, data, port, address) {
            void settingsService.readSettings().then((current) => {
              const reply = listening && discoveryReply(data.toString(), address, current, listening)
              if (reply) udp.send(reply, port, address)
            }).catch((error) => console.warn('[Jellyfin] Could not answer discovery', { error }))
          }
        }
      })
      console.info('[Jellyfin] Answering discovery on the network', { port: DISCOVERY_PORT })
    } catch (error) {
      // Another server, such as Jellyfin itself, may answer on this port already.
      console.warn('[Jellyfin] Discovery is unavailable', { port: DISCOVERY_PORT, error: (error as Error).message })
    }
  } else if (!enabled && socket) {
    socket.close()
    socket = undefined
    console.info('[Jellyfin] Stopped answering discovery')
  }
}
