// Basic filename parser to get a searchable title.
// e.g., "The.Movie.(2023).1080p.mkv" -> "The Movie"
export function parseTitle(name: string): string {
  // 1. Only remove known video extensions. This is the key fix to avoid stripping ". 2" from folder names.
  let cleaned = name.replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i, '')

  // 2. Replace dots and underscores with spaces
  cleaned = cleaned.replace(/[._]/g, ' ')

  // 3. Remove common technical tags
  cleaned = cleaned.replace(
    /\b(1080p|720p|4k|uhd|bluray|dvd|x264|x265|aac|hevc|web-dl|webrip|brrip)\b/gi,
    ' '
  )

  // 4. Trim whitespace so the "end of string" anchor `$` works correctly for the year.
  cleaned = cleaned.trim()

  // 5. Remove year if it is at the end of the string and enclosed in () or []
  cleaned = cleaned.replace(/\s*[\[(](19|20)\d{2}[)\]]\s*$/, '')

  // 6. Final cleanup of any remaining multiple spaces and trim.
  return cleaned.replace(/\s+/g, ' ').trim()
}
