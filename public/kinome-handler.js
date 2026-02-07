#!/usr/bin/env node

// kinome-handler.js - Local Protocol Handler for kinome://
// Handles two command types:
// 1. kinome://run?secret=XXX&command=BASE64_ENCODED_COMMAND
// 2. kinome://test?secret=XXX&url=BASE64_ENCODED_URL

const fs = require('fs').promises
const path = require('path')
const { spawn } = require('child_process')

const CONFIG_DIR = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'Kinome')
    : path.join(process.env.HOME || '', '.config', 'kinome')

const CONFIG_FILE = path.join(CONFIG_DIR, 'handler-config.json')
const LOG_FILE = path.join(CONFIG_DIR, 'handler.log')

// Parse kinome:// URL from command line
const url = process.argv[2] || ''

async function log(message) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}\n`
    try {
        await fs.appendFile(LOG_FILE, logMessage)
    } catch (e) {
        console.error('Failed to write log:', e.message)
    }
}

async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8')
        return JSON.parse(data)
    } catch (e) {
        await log(`ERROR: Failed to load config: ${e.message}`)
        process.exit(1)
    }
}

function validateSecret(config, providedSecret) {
    if (!config.secrets || !Array.isArray(config.secrets)) {
        return false
    }
    return config.secrets.includes(providedSecret)
}

function maskToken(url) {
    return url.replace(/(token=)([^&]{3})[^&]*([^&]{3})/g, '$1$2***$3')
}

async function executeCommand(commandString) {
    await log(`Executing: ${maskToken(commandString)}`)

    try {
        // Parse command into shell and arguments
        const parts = commandString.match(/(?:[^\s"]+|"[^"]*")+/g) || []
        const shell = parts[0]
        const args = parts.slice(1).map(arg => arg.replace(/^"|"$/g, ''))

        spawn(shell, args, {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32' // Windows needs shell for path resolution
        }).unref()

        await log('Command spawned successfully')
    } catch (error) {
        await log(`ERROR: Command execution failed: ${error.message}`)
    }
}

async function pingHandshakeUrl(url) {
    await log(`Pinging handshake URL: ${url}`)

    try {
        const https = url.startsWith('https') ? require('https') : require('http')

        await new Promise((resolve, reject) => {
            const req = https.get(url, (res) => {
                if (res.statusCode === 200) {
                    resolve()
                } else {
                    reject(new Error(`Handshake failed: HTTP ${res.statusCode}`))
                }
            })
            req.on('error', reject)
            req.setTimeout(5000, () => {
                req.destroy()
                reject(new Error('Handshake timeout'))
            })
        })

        await log('Handshake successful')
    } catch (error) {
        await log(`ERROR: Handshake failed: ${error.message}`)
    }
}

async function main() {
    await log(`Handler invoked with URL: ${url}`)

    if (!url.startsWith('kinome://')) {
        await log('ERROR: Invalid protocol (expected kinome://)')
        process.exit(1)
    }

    // Parse URL
    const urlObj = new URL(url)
    const action = urlObj.hostname || urlObj.pathname.replace('//', '').split('?')[0]
    const params = new URLSearchParams(urlObj.search)

    const secret = params.get('secret')

    // Load config and validate secret
    const config = await loadConfig()

    if (!validateSecret(config, secret)) {
        await log('ERROR: Secret validation failed')
        process.exit(1)
    }

    await log('Secret validated')

    // Handle action
    if (action === 'run') {
        const encodedCommand = params.get('command')
        if (!encodedCommand) {
            await log('ERROR: Missing command parameter')
            process.exit(1)
        }

        const commandString = Buffer.from(encodedCommand, 'base64').toString('utf8')
        await executeCommand(commandString)

    } else if (action === 'test') {
        const encodedUrl = params.get('url')
        if (!encodedUrl) {
            await log('ERROR: Missing url parameter')
            process.exit(1)
        }

        const handshakeUrl = Buffer.from(encodedUrl, 'base64').toString('utf8')
        await pingHandshakeUrl(handshakeUrl)

    } else {
        await log(`ERROR: Unknown action: ${action}`)
        process.exit(1)
    }

    process.exit(0)
}

main().catch(async (error) => {
    await log(`FATAL: ${error.message}`)
    process.exit(1)
})
