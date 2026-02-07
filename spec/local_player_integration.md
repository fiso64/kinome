# Spec: Secure Local Player Integration

**Version:** 1.0
**Status:** Proposed

---

## 1. Abstract

This specification details a feature to allow the Kinome web client to securely launch media files in local desktop players (like MPV, VLC) on the user's machine. This bridges the gap between the web-based server architecture and the rich playback experience of native desktop applications, using a custom custom protocol handler (`kinome://`) secured by a client-specific shared secret to prevent unauthorized execution.

## 2. Problem Statement / Motivation

Kinome has evolved from a local Electron app to a client-server web application. This introduced a regression: the server can no longer directly execute commands on the client's machine.
Users accessing Kinome via a web browser currently have no way to open media in their preferred high-fidelity local players (which support HDR, advanced upscaling, etc.) directly from the UI. They are limited to the browser's video capabilities or manually copying links.

- **User Story:** As a user with a high-end home theater setup, I want to click "Play in MPV" in the Kinome web UI and have it open instantly on my TV without manual copy-pasting or terminal windows popping up.

## 3. Goals and Non-Goals

### Goals

- **Secure Execution:** Prevent malicious websites from triggering the `kinome://` handler to execute arbitrary commands.
- **Deep Compatibility:** Support arbitrary user-defined player commands (e.g., `mpv --fullscreen {url}`).
- **Seamless UX:** Launch players "invisibly" (no flashing terminal windows).
- **Easy Setup:** Provide copy-paste installation scripts for Windows (PowerShell) and Linux (Bash).
- **Built-in Utilities:** Integrate "Copy Playlist Link" as a first-class citizen in the player command list.

### Non-Goals

- **Server-side playback:** This feature is strictly for client-side playback.
- **Bi-directional control:** The web UI will not control the player (pause/seek) once launched (fire-and-forget).
- **Automatic Installation:** We cannot automatically install protocol handlers from a web page; the user must manually run a script once.

## 4. Proposed Solution & Technical Design

The solution involves a "Client Secret" handshake between the browser and a locally installed protocol handler.

### 4.1. The Security Model: Client Secrets

To preventing unauthorized command execution (e.g., `kinome://run?cmd=rm%20-rf`), the system uses a **Shared Secret** model:

1.  **Generation:** When the user opens the "Install Player" modal, the Web UI generates a random UUID (the "Client Secret") and stores it in `localStorage`.
2.  **Installation:** The user runs an installation script that embeds this secret into a local configuration file (e.g., `%APPDATA%\kinome\handler-config.json` on Windows, matching the server's data directory case).
3.  **Invocation:** When launching a player, the Web UI constructs a URI including the secret: `kinome://run?secret=<UUID>&command=<BASE64_CMD>`.
4.  **Validation:** The local handler intercepts the URI, compares the received secret with the stored secret. If they match, the command executes. If not, it terminates silently.

This ensures that only the specific browser instance that generated the installer can trigger commands.

### 4.2. URL Scheme & Zero-Latency Execution

To achieve **zero network latency** when clicking "Play", the URL construction happens entirely on the **Client Side**.

1.  **Configuration:** The frontend receives `playerCommands` (e.g., `mpv --fs {url}`) via the standard `getSettings()` API call at startup.
2.  **Execution:** When the user clicks "Play":
    - Frontend retrieves the local `Client Secret` from `localStorage`.
    - Frontend generates the full `Playlist URL` locally (including the active auth token).
    - Frontend performs string replacement on the command template.
    - Frontend constructs the `kinome://` URI.
    - **Result:** Immediate handoff to the OS handler with 0ms network overhead.

**Protocol Structure:**
```
kinome://run?secret=<CLIENT_SECRET>&command=<BASE64_ENCODED_COMMAND>
```

- `secret`: The client validation token (UUID).
- `command`: The **fully-rendered, executable command**, base64-encoded.

**Example (decoded command):**
```bash
mpv --fullscreen http://server:3001/api/playlist/abc123?token=xyz789
```

**Rationale:** By passing the complete command, we keep the handler script simple (decode → validate → execute) and centralize all template logic in the Web UI where we have full context about the media item, server URL, and auth tokens.

### 4.3. UI / Frontend Changes

**`PlayerCommandsModal.svelte`** will be refactored into two primary states:

1.  **Setup Mode (Default if no secret exists):**
    - Generates and displays the `Client Secret`.
    - Provides "One-Liner" install commands for:
        - **Windows:** `irm .../install.ps1 | iex` (PowerShell)
        - **Linux:** `curl ... | bash`
    - **"Test Connection" button** (always visible) - Triggers a special `kinome://test` command to verify the handler is installed and working.
    - Upon successful test, automatically unlocks the Management Mode UI.

2.  **Management Mode:**
    - **"Test Connection" button** (always visible at top) - For ongoing verification and troubleshooting.
    - Standard CRUD list for player configurations.
    - **"Copy Playlist Link"**: pinned as a built-in, non-editable command.

**Playing function:**
- Checks if the selected command is the special `builtin:copy-link`.
- If standard custom command: 
  - Performs template replacement: `{url}` → full playlist URL with token
  - Base64-encodes the final command
  - Constructs the `kinome://run?secret=...&command=...` URI
  - Navigates to it via hidden iframe or `window.location.href`

### 4.4. Handler Test & Recovery Flow

**The Test Button** is a critical feature for both initial setup and ongoing maintenance:

**Test Protocol:**
```
kinome://test?secret=<CLIENT_SECRET>&url=<BASE64_ENCODED_HANDSHAKE_URL>
```

**Test Flow:**
1. **Frontend clicks "Test Connection"**
   - Generates a unique `sessionId` (UUID)
   - Calls backend API: `POST /api/start-handler-test` with `{ sessionId }`
   - Backend creates a pending test session and waits for handler ping
   - Frontend shows loading state: "Testing connection..."

2. **Frontend triggers handler**
   - Constructs handshake URL: `http://server:3001/api/handler-test/<sessionId>`
   - Base64-encodes it
   - Constructs test URL: `kinome://test?secret=<CLIENT_SECRET>&url=<BASE64_ENCODED_URL>`
   - Navigates to the test URL (via hidden iframe or `window.location.href`)

3. **Handler receives test command**
   - Decodes the URL parameter
   - Validates the secret against stored config
   - If valid: Makes HTTP GET request to the decoded handshake URL
   - If invalid: Terminates silently

4. **Backend receives handler ping**
   - Endpoint `/api/handler-test/<sessionId>` receives GET from handler
   - Marks test session as successful
   - Notifies frontend via WebSocket: `{ type: 'handler-test-success', sessionId }`

5. **Frontend receives success notification**
   - Clears loading state
   - Shows success message: "✓ Handler connected successfully!"
   - If in Setup Mode: Automatically unlocks Management Mode

**Timeout Handling:**
- Frontend waits up to 5 seconds for WebSocket notification
- If timeout: Shows error message with troubleshooting tips

**Lost Secret Recovery:**
When a user's `localStorage` is cleared or they switch browsers:

1. UI detects missing secret in `localStorage`
2. Shows Setup Mode again with newly generated secret
3. User runs the installer script (which **appends** the new secret per Section 4.5)
4. User clicks "Test Connection" to verify
5. Both old and new secrets now work (if old handler-config still exists)

**When Test Fails:**
- UI shows troubleshooting tips:
  - "Re-run the installer script"
  - "Check if handler is registered" (OS-specific instructions)
  - "Verify your firewall allows the handler to access the server"
  - Link to manual installation documentation

### 4.5. The Installation Scripts

The server will host static assets (or generate them via API) for the installers.

**Windows Installer (`install.ps1`):**
1.  Creates `%APPDATA%\Kinome`.
2.  Writes `config.json` with the provided Secret (or **appends** if the file already exists).
3.  Creates a `launcher.vbs` shim (to hide the console window).
4.  Registers `HKCU\Software\Classes\kinome` to point to `wscript.exe launcher.vbs "%1"`.

**Linux Installer (`install.sh`):**
1.  Creates `~/.config/kinome`.
2.  Writes `config.json` (or **appends** if the file already exists).
3.  Creates `~/.local/bin/kinome-handler`.
4.  Creates `~/.local/share/applications/kinome.desktop` (with `Terminal=false`).

**Config File Format (`handler-config.json`):**
```json
{
  "secrets": ["uuid-1", "uuid-2", "uuid-3"]
}
```
This allows multiple browser instances/profiles to register their own secrets.

### 4.6. Stream Authentication

External players cannot access the API without authentication.

**Internal Logic:**
- The **Installer** will append the new secret to the list of authorized secrets in `handler-config.json`.
- The **command passed to the handler** will always be fully-rendered and include authentication:
  - Example: `mpv --fullscreen http://server:3001/api/playlist/abc123?token=xyz789`
  - The playlist URL includes the auth token in the query string
  - No additional authentication is needed by the handler

**Template Variables Available in UI:**
- `{url}`: Replaced by the full M3U8 playlist URL with embedded auth token
  - Example: `http://server:3001/api/playlist/abc123?token=xyz789`
- Future enhancements could add `{title}`, `{year}`, `{path}`, etc.

**Backend Requirements:**
- ✅ **Already Implemented:** The backend accepts `?token=` query parameters (see `server.ts` auth middleware)
- ✅ **Already Implemented:** Tokens in query params are validated the same as `Authorization: Bearer` tokens

## 5. Edge Cases & Solutions

- **Multiple Browser Profiles / Lost Secrets:** Addressed by the **Test & Recovery Flow** (Section 4.4). Users can generate new secrets, and the installer appends them to the config file, allowing multiple secrets to coexist.
- **Browser Security Policies:** Modern browsers will prompt "Open kinome:// ?" when launching the handler. This is unavoidable but expected behavior.
- **Handler Not Installed:** The Test button provides immediate feedback. If the test fails, users see clear troubleshooting instructions.
- **Silent Failures:** Since the handler terminates silently on validation failure, the Test button is essential for verifying correct installation and secret synchronization.

## 6. Security Considerations

- **Secret Entropy:** Client secrets are UUIDs (128-bit), providing sufficient entropy against brute-force attacks.
- **Secret Storage:** Secrets are stored in `localStorage` (Web UI) and plain JSON files (local handler). This is acceptable since:
  - The threat model assumes the attacker is a **malicious website**, not local malware.
  - If an attacker has local file access, they already have access to the media library itself.
- **Command Injection:** The handler executes arbitrary commands by design. The secret is the sole defense. Users must keep their secret confidential.

## 7. Alternatives Considered

- **Unsecured Protocol:** Sending just the file ID (`kinome://play/123`) and letting the local script lookup the path. REJECTED: Requires the local script to know the Server URL and have API access, increasing complexity and config synchronization issues. The "Dumb Executor" model with a Secret is more robust.
- **Native GUI / Terminal Pairing:** Using `kinome://pair` to trigger a system dialog (PowerShell MessageBox or Terminal prompt) asking the user to approve a new client secret. DEFERRED: Adds significant cross-platform complexity (handling window focus, UI dependencies on Linux) compared to the stateless "Dumb Executor" script. May be revisited for V2 with a dedicated Go/Rust helper binary.
