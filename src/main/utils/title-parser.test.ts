/**
 * Title Parser Tests
 *
 * Tests the filename → searchable title extraction logic.
 * Pure function, zero dependencies, stable utility.
 */
import { describe, it, expect } from 'bun:test'
import { parseTitle } from './title-parser'

describe('parseTitle', () => {
    it('strips video file extensions', () => {
        expect(parseTitle('The.Movie.mkv')).toBe('The Movie')
        expect(parseTitle('Something.mp4')).toBe('Something')
    })

    it('replaces dots and underscores with spaces', () => {
        expect(parseTitle('The.Movie.Name')).toBe('The Movie Name')
        expect(parseTitle('The_Movie_Name')).toBe('The Movie Name')
    })

    it('removes common technical tags', () => {
        expect(parseTitle('Movie.Name.1080p.BluRay.x264.mkv')).toBe('Movie Name')
        expect(parseTitle('Movie.4K.UHD.HEVC.mkv')).toBe('Movie')
    })

    it('removes trailing year in brackets/parens', () => {
        expect(parseTitle('The Movie (2023)')).toBe('The Movie')
        expect(parseTitle('The Movie [2023]')).toBe('The Movie')
    })

    it('preserves year when NOT at end or NOT in brackets', () => {
        // Inline year without brackets should stay
        expect(parseTitle('2001 A Space Odyssey')).toBe('2001 A Space Odyssey')
    })

    it('handles complex real-world filenames', () => {
        const result = parseTitle('The.Movie.Name.(2023).1080p.BluRay.x264.mkv')
        expect(result).toBe('The Movie Name')
    })

    it('preserves folder names with trailing numbers', () => {
        // The key fix mentioned in the code: avoid stripping ". 2" from folder names
        expect(parseTitle('The Godfather Part. 2')).toBe('The Godfather Part 2')
    })

    it('handles already clean names', () => {
        expect(parseTitle('My Movie')).toBe('My Movie')
    })

    it('collapses multiple spaces', () => {
        expect(parseTitle('Movie   Name')).toBe('Movie Name')
    })
})
