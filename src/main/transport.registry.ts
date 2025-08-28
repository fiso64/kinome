import type { ITransport } from './transport/transport.interface'

let transport: ITransport | null = null

/**
 * Sets the global transport instance. This should be called once at startup.
 * @param instance The transport layer implementation (e.g., IpcTransport).
 */
export function setTransport(instance: ITransport): void {
  if (transport) {
    console.warn('[Transport Registry] Transport instance is being overwritten.')
  }
  console.log('[Transport Registry] Transport instance has been set.')
  transport = instance
}

/**
 * Retrieves the global transport instance.
 * Services should use this to send notifications to the client.
 * @returns The configured ITransport instance.
 */
export function getTransport(): ITransport {
  if (!transport) {
    throw new Error('Transport has not been initialized. Call setTransport() at startup.')
  }
  return transport
}