import fs from 'fs'
import path from 'path'

const handlerTestSessions = new Map<string, { timestamp: number }>()
const TEST_SESSION_TIMEOUT = 10000 // 10 seconds

// Cleanup expired sessions periodically
setInterval(() => {
    const now = Date.now()
    for (const [sessionId, session] of handlerTestSessions.entries()) {
        if (now - session.timestamp > TEST_SESSION_TIMEOUT) {
            handlerTestSessions.delete(sessionId)
        }
    }
}, 30000)

/**
 * Starts a new handler test session.
 * The handler will ping back to /api/handler-test/:sessionId to confirm it's working.
 */
export function startHandlerTest(sessionId: string): void {
    handlerTestSessions.set(sessionId, { timestamp: Date.now() })
}

/**
 * Confirms a handler test session and removes it.
 * Returns true if the session existed and was valid, false otherwise.
 */
export function confirmHandlerTest(sessionId: string): boolean {
    const session = handlerTestSessions.get(sessionId)
    if (!session) return false

    handlerTestSessions.delete(sessionId)
    return true
}

/**
 * Generates the Windows PowerShell installer script with embedded secret.
 */
export function generateWindowsInstaller(secret?: string, baseUrl?: string): string {
    // Find the script path - handle both production (relative to exe) and dev (cwd)
    const exeDir = path.dirname(process.execPath)
    const pathInExeDir = path.join(exeDir, 'public', 'install-kinome-handler.ps1')
    const pathInCwd = path.join(process.cwd(), 'public', 'install-kinome-handler.ps1')

    const scriptPath = fs.existsSync(pathInExeDir) ? pathInExeDir : pathInCwd

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Installer script not found at ${scriptPath}`)
    }

    let scriptContent = fs.readFileSync(scriptPath, 'utf8')

    // Strip BOM if present
    if (scriptContent.charCodeAt(0) === 0xFEFF) {
        scriptContent = scriptContent.slice(1)
    }

    // Inject variables at the top
    let injections = ''
    if (secret) {
        injections += `$Secret = "${secret}"\n`
    }
    if (baseUrl) {
        injections += `$BaseUrl = "${baseUrl}"\n`
    }

    if (injections) {
        scriptContent = injections + scriptContent
    }

    return scriptContent
}

/**
 * Generates the Linux/macOS bash installer script with embedded secret.
 */
export function generateLinuxInstaller(secret?: string, baseUrl?: string): string {
    // Find the script path - handle both production (relative to exe) and dev (cwd)
    const exeDir = path.dirname(process.execPath)
    const pathInExeDir = path.join(exeDir, 'public', 'install-kinome-handler.sh')
    const pathInCwd = path.join(process.cwd(), 'public', 'install-kinome-handler.sh')

    const scriptPath = fs.existsSync(pathInExeDir) ? pathInExeDir : pathInCwd

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Installer script not found at ${scriptPath}`)
    }

    let scriptContent = fs.readFileSync(scriptPath, 'utf8')

    // Strip BOM if present
    if (scriptContent.charCodeAt(0) === 0xFEFF) {
        scriptContent = scriptContent.slice(1)
    }

    // Inject variables at the top (after shebang)
    let injections = ''
    if (secret) {
        injections += `SECRET='${secret}'\n`
    }
    if (baseUrl) {
        injections += `BASE_URL='${baseUrl}'\n`
    }

    if (injections) {
        // Insert after the first line (shebang)
        const lines = scriptContent.split('\n')
        if (lines.length > 0 && lines[0].startsWith('#!')) {
            lines.splice(1, 0, injections)
            scriptContent = lines.join('\n')
        } else {
            scriptContent = injections + scriptContent
        }
    }

    return scriptContent
}