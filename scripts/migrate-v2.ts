
import { initializeDatabase, closeDatabase } from '../src/main/database/client'
import { migrateTvStructure } from '../src/main/services/migration.service'
import { initializeStartup } from '../src/main/services/startup.service'
import path from 'path'
import os from 'os'
import fs from 'fs'

async function run() {
    try {
        // 1. Resolve User Data Path (Same logic as server.ts)
        const appName = 'media-browser'
        let defaultPath = ''
        if (process.platform === 'win32') {
            defaultPath = path.join(process.env.APPDATA || '', appName)
        } else if (process.platform === 'darwin') {
            defaultPath = path.join(process.env.HOME || '', 'Library', 'Application Support', appName)
        } else {
            defaultPath = path.join(process.env.HOME || '', '.config', appName)
        }

        const userDataPath = process.env.USER_DATA_PATH || defaultPath

        console.log('------------------------------------------------')
        console.log('Running V2 Migration Script')
        console.log(`Target User Data Path: ${userDataPath}`)
        console.log('------------------------------------------------')

        if (!fs.existsSync(userDataPath)) {
            console.error(`❌ User data path does not exist: ${userDataPath}`)
            console.error('   Ensure you have run "pnpm dev" at least once to create the database.')
            process.exit(1)
        }

        // 2. Initialize
        initializeStartup(userDataPath)
        initializeDatabase() // This might trigger ALTER TABLEs if not already run

        // 3. Migrate Data
        await migrateTvStructure()

        console.log('✅ Migration completed successfully.')
    } catch (e) {
        console.error('❌ Migration failed:', e)
        process.exit(1)
    } finally {
        closeDatabase()
    }
}

run()
