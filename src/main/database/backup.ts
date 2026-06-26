import type { Database } from 'bun:sqlite'
import fs from 'fs'
import path from 'path'

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function createPreMigrationBackup(
  db: Database,
  dbPath: string,
  fromVersion: number,
  toVersion: number,
  now = new Date()
): string {
  const backupDir = path.join(path.dirname(dbPath), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })

  const backupPath = path.join(
    backupDir,
    `library.before-v${fromVersion}-to-v${toVersion}.${timestampForFilename(now)}.db`
  )

  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`)
  return backupPath
}
