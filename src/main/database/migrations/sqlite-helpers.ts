import type { Database } from 'bun:sqlite'

export function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return !!row
}

export function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}
