Here is the updated analysis of the API and feature set in the context of the Client-Server migration.

### 1. Context Menu "Action at a Distance"

While `SettingsModal.svelte` correctly disables the configuration of player commands for the Web UI, the **Context Menu** (`ContextMenu.svelte`) does not respect this distinction.

- **"Play with..." Submenu:**

  - **Issue:** The backend (`settings.service.ts`) provides default player commands (e.g., mpv) even if the user hasn't configured any. The `web-api.ts` retrieves these settings. The Context Menu renders them as options.
  - **Result:** If a user clicks "Play with mpv" in their browser, the server receives a request to spawn a child process (`child_process.exec`). This attempts to launch a video player **on the server machine**.
  - **Fix:** The Context Menu should hide the "Play with..." section entirely when running in the web client, or `web-api.ts` should strip these commands from the settings object it returns.

- **"Show in Explorer":**
  - **Issue:** This calls `api.revealInExplorer`, which triggers a system command (`explorer.exe`, `open`, `xdg-open`) on the backend.
  - **Result:** This opens a file manager window on the server's desktop. If the server is headless, this fails silently or errors. If it's a desktop server, it pops up a window away from the user.
  - **Fix:** This feature should be hidden in the web client.

### 2. Client-Side File Picking (The "Upload" Gap)

The application architecture relies on passing file path strings (e.g., `C:/images/poster.jpg`) to the backend. Browsers cannot provide these paths for security reasons, nor can the Node.js server read them from the client machine.

- **Artwork "Choose Local File":**

  - **Issue:** In `ManualSearchModal.svelte`, the "Choose Local File" button calls `window.api.selectLocalImage`.
  - **Status:** In `web-api.ts`, this function is stubbed to log a warning and return `null`.
  - **Result:** The button is clickable but performs no action.
  - **Fix:** This requires a fundamental architectural change. The frontend needs an `<input type="file">` to accept a binary blob, and the API needs a multipart upload endpoint (e.g., `/api/upload-image`) to stream that file to the server's `images` directory.

- **"Open Existing Library":**
  - **Issue:** In `MainView.svelte`, the "Open Existing Library" button calls `api.selectLibraryDirectory`.
  - **Status:** In `web-api.ts`, this is stubbed to return `null`.
  - **Result:** The button is dead.
  - **Fix:** Since the web client cannot trigger a native OS folder picker on the server, this requires a custom server-side directory browsing API so the user can navigate the server's file system within the web UI to select a folder.

### 3. Window Management (UI Artifacts)

- **Window Controls:**
  - **Issue:** `AppHeader.svelte` includes the `WindowControls` component (Minimize, Maximize, Close).
  - **Status:** `web-api.ts` implements these as console logs (No-ops).
  - **Result:** The buttons appear in the browser header but do nothing, which is confusing and visually redundant for a web app.
  - **Fix:** These components should be conditionally rendered or removed for the web build.

### 4. Custom Actions

- **Ambiguity:**
  - **Issue:** Custom actions allow defining shell commands. In the web version, these still execute on the server.
  - **Context:** Unlike "Play with...", running a command on the server _might_ be intended (e.g., "Delete this file" or "Run ffmpeg conversion").
  - **Recommendation:** This feature works technically, but the UI provides no indication that the action is server-side. It should probably be kept but clarified in the UI, unlike the Player Commands which are strictly display-oriented.
