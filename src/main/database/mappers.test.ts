/**
 * Mapper Utility Tests
 *
 * Tests the parseJsonSafe function — a critical utility used throughout
 * the codebase for safe JSON parsing with fallback values.
 */
import { describe, it, expect } from 'bun:test'
import { parseJsonSafe } from './mappers'

describe('parseJsonSafe', () => {
    it('parses valid JSON', () => {
        expect(parseJsonSafe('{"a":1}', {})).toEqual({ a: 1 })
        expect(parseJsonSafe('[1,2,3]', [] as any[])).toEqual([1, 2, 3])
        expect(parseJsonSafe('"hello"', '')).toBe('hello')
    })

    it('returns fallback for null input', () => {
        expect(parseJsonSafe(null, {})).toEqual({})
        expect(parseJsonSafe(null, [] as any[])).toEqual([])
        expect(parseJsonSafe(null, 'default')).toBe('default')
    })

    it('returns fallback for empty string', () => {
        expect(parseJsonSafe('', {})).toEqual({})
    })

    it('returns fallback for invalid JSON', () => {
        expect(parseJsonSafe('{not json}', {})).toEqual({})
        expect(parseJsonSafe('undefined', [] as any[])).toEqual([])
    })

    it('returns fallback when parsed value is null', () => {
        // JSON "null" is valid JSON but should return the fallback
        expect(parseJsonSafe('null', {})).toEqual({})
        expect(parseJsonSafe('null', [] as any[])).toEqual([])
    })

    it('returns 0 and false as valid values (not fallback)', () => {
        expect(parseJsonSafe('0', 999)).toBe(0)
        expect(parseJsonSafe('false', true)).toBe(false)
    })
})
