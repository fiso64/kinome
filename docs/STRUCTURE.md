# Project Structure

This document provides a high-level overview of the project's structure to help you find your way around the codebase.

## Core Directories

The application is divided into three main parts, following the standard Electron process model, plus a shared directory.

-   `src/main`: **Backend / Main Process**
-   `src/preload`: **Bridge / Preload Script**
-   `src/renderer`: **Frontend / Renderer Process**
-   `src/shared`: **Shared Code**

---

### `src/main` (Backend)

This is the Node.js environment where all the core application logic resides. The backend is further split into a **transport** layer and a **service** layer to ensure a clean separation of concerns.

-   `index.ts`: The main application entry point. It's responsible for the Electron application lifecycle, creating the `BrowserWindow`, and bootstrapping the other backend modules. It contains minimal application logic.

#### `src/main/transport`

This layer is responsible for all communication between the backend and the outside world (specifically, the renderer process). It is the *only* part of the backend that should depend on Electron-specific modules like `ipcMain` and `BrowserWindow`.

-   `ipc.ts`: The central hub for all Inter-Process Communication (IPC). It defines all `ipcMain` handlers that the renderer can invoke. Each handler typically calls a function from the corresponding service, acting as a bridge between the renderer's requests and the core business logic. It also subscribes to events from the service layer to push updates to the renderer.

#### `src/main/services`

This layer contains the core business logic of the application. These modules are "pure" Node.js modules, completely decoupled from Electron. This makes them portable, easier to test, and reusable.

-   `library.service.ts`: The heart of the backend. It's responsible for:
    -   Loading, saving, and managing the in-memory database.
    -   Scanning the user's media source for new or removed files.
    -   Coordinating metadata fetching via the `retriever.service`.
    -   Handling most of the business logic (e.g., `getItemDetails`, `playFile`, `updateItem`).
-   `search.service.ts`: Manages the in-memory search index using `Fuse.js`. It includes logic for building the index and performing fast, fuzzy searches. It also contains the `Proxy` logic that detects changes to the database object in memory.
-   `retriever.service.ts`: Handles all external communication with the TMDB API. It fetches metadata (details, credits, images) and downloads images to the local library cache.
-   `settings.service.ts`: Manages reading and writing configuration. It merges settings from three levels: hardcoded defaults, a global `settings.json`, and a per-library `library-settings.json`.
-   `paths.service.ts`: A small but critical module for resolving paths within the library data directory. It correctly handles both local file paths and remote HTTP URLs.
-   `virtualTags.service.ts`: Contains the logic for evaluating user-defined expressions to create "virtual tags" on library items.
-   `startup.service.ts`: A special script that runs *before* `index.ts`. It performs a synchronous read of the global settings file to determine the library path, which is crucial for setting up the correct environment before other modules load.
-   `event.emitter.service.ts`: Provides a global event emitter instance. This is the key to decoupling the service layer from the transport layer. Services emit events here (e.g., `library-items-updated`), and the transport layer (`ipc.ts`) listens for these events to notify the renderer.

### `src/preload` (Bridge)

This script acts as a secure bridge between the `main` process (Node.js) and the `renderer` process (browser).

-   `index.ts`: Exposes a well-defined `window.api` object to the renderer. This is the API contract that the frontend uses to interact with the backend. Each function in `window.api` typically corresponds to an `ipcMain.handle` in `transport/ipc.ts`.
-   `index.d.ts`: Provides TypeScript definitions for `window.api`, allowing the Svelte/TypeScript code in the renderer to use it with full type safety and autocompletion.

### `src/renderer` (Frontend)

This is the user interface of the application, built with Svelte and TypeScript. It runs in a Chromium browser environment.

-   `src/main.ts`: The entry point for the renderer. It mounts the root `App.svelte` component into the DOM.
-   `src/App.svelte`: The top-level Svelte component. It manages the global UI state, such as:
    -   The view stack (tracking navigation through folders).
    -   The currently active modal dialog.
    -   Global search state and results.
    -   It sets up listeners (`window.api.on...`) to receive real-time updates from the `main` process.
-   `src/components/`: Contains all the Svelte components, organized by function.
    -   `layout/`: High-level components that structure the UI, like `AppHeader`, `MainView`, `ItemDetail`.
    -   `views/`: The different ways to display a list of media items, such as `GridView`, `ListView`, `TabsView`, and `SectionsView`. These are the core of the flexible UI engine.
    -   `modals/`: All modal dialogs, like `SettingsModal`, `ItemSettingsModal`, etc.
    -   `ui/`: Reusable, general-purpose UI elements like `SearchInput`, `ContextMenu`, `FilterBar`, and `Dialog`.
-   `src/lib/`: Client-side TypeScript modules (helpers, stores, etc.).
    -   `item-store.ts`: A critical performance-enhancing module. It implements a client-side cache for library items, reducing the need for repeated IPC calls and managing the lazy-loading of folder contents.
    -   `shortcuts.ts`: Defines and manages global keyboard shortcuts (e.g., `Ctrl+L` to focus search).
    -   `dialog-store.ts`: A Svelte store for managing and queuing confirmation and error dialogs.
    -   `autocomplete-manager.ts`: A reusable Svelte action (`use:autocomplete`) for powering suggestion menus in input fields.
    -   `view-state-store.ts`: Svelte stores for managing UI state that needs to persist across component lifecycles, like the active tab in a `TabsView`.

### `src/shared` (Shared Code)

This directory contains code that is used by two or more of the processes (`main`, `preload`, `renderer`).

-   `types.ts`: The single source of truth for all major data structures in the application (e.g., `LibraryItem`, `Settings`). This is one of the most important files for understanding how data flows through the app.
-   `settings-helpers.ts`: Contains the complex logic for resolving view settings. Since both the backend (applying defaults) and frontend (displaying settings modals) need this logic, it's shared here.
-   `filter.ts`: Contains the client-side logic for filtering a list of items based on a search query. Used by the `FilterBar` and `MediaView` components.