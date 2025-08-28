import { EventEmitter } from 'events'

/**
 * A global event emitter for communication between service and transport layers.
 * Services emit events here, and the transport layer (e.g., ipc.ts) listens.
 */
export const serviceEventEmitter = new EventEmitter()