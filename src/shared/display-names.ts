/**
 * Friendly display titles for internal field values.
 *
 * Keyed by field name, then by raw value → display string.
 * Add entries here as needed — any value without an explicit
 * mapping falls through to a default titleCase formatter.
 */
const VALUE_DISPLAY_NAMES: Record<string, Record<string, string>> = {
    mediaType: {
        movie: 'Movies',
        tv: 'TV Shows',
        episode: 'Episodes',
        season: 'Seasons'
    }
}

/**
 * Returns a user-friendly display title for a grouping field value.
 * Checks VALUE_DISPLAY_NAMES first, then falls back to titleCase.
 */
export function displayTitle(field: string, value: string): string {
    return VALUE_DISPLAY_NAMES[field]?.[value] ?? titleCase(value)
}

function titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
}
