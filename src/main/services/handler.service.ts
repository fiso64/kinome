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
export function generateWindowsInstaller(secret?: string): string {
    const fs = require('fs')
    const path = require('path')

    const scriptPath = path.join(process.cwd(), 'public', 'install-kinome-handler.ps1')
    let scriptContent = fs.readFileSync(scriptPath, 'utf8')

    if (secret) {
        scriptContent = `$Secret = '${secret}'\n` + scriptContent
    }

    return scriptContent
}

/**
 * Generates the Linux/macOS bash installer script with embedded secret.
 */
export function generateLinuxInstaller(secret?: string): string {
    const fs = require('fs')
    const path = require('path')

    const scriptPath = path.join(process.cwd(), 'public', 'install-kinome-handler.sh')
    let scriptContent = fs.readFileSync(scriptPath, 'utf8')

    if (secret) {
        scriptContent = `SECRET='${secret}'\n` + scriptContent
    }

    return scriptContent
}
