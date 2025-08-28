# Project Structure

This document provides a high-level overview of the project's structure to help new developers find their way around the codebase.

## Core Directories

The application is divided into three main parts, following the standard Electron process model, plus a shared directory.

-   `src/main`: **Backend / Main Process**
-   `src/preload`: **Bridge / Preload Script**
-   `src/renderer`: **Frontend / Renderer Process**
-   `src/shared`: **Shared Code**

---

### `src/main` (Backend)

This is the Node.js environment where all core application logic resides. It is split into a **transport** layer and a **service** layer to ensure a clean separation of concerns.

-   `index.ts`: The main application entry point. Responsible for the Electron app lifecycle, creating the `BrowserWindow`, and bootstrapping the transport and service layers.
-   `transport.registry.ts`: Holds the global transport instance (`IpcTransport`). This enables services to communicate with the frontend without a direct dependency on Electron, supporting dependency inversion.

#### `src/main/transport`

This layer is responsible for all communication between the backend and the renderer process. It is the *only* part of the backend that should depend on Electron-specific modules like `ipcMain`.

-   `transport.interface.ts`: Defines the `ITransport` interface, the contract for communication between services and the renderer. This abstraction is key to decoupling services from Electron.
-   `ipc.transport.ts`: The Electron-specific implementation of `ITransport`. Manages all `ipcMain` handlers and sends events to the renderer process.

#### `src/main/services`

Contains the core business logic. These are pure Node.js modules, **completely decoupled from Electron**. They communicate with the frontend via the abstract `ITransport` interface, making them portable and testable.

-   `library.service.ts`: The heart of the backend. Manages the in-memory database, scans the media source, coordinates metadata fetching, and handles core business logic (`playFile`, `updateItem`, etc.).
-   `search.service.ts`: Manages the `Fuse.js` search index. Includes the `Proxy` that automatically detects database changes to keep the index and UI in sync.
-   `retriever.service.ts`: Handles all communication with the TMDB API for fetching metadata and images.
-   `settings.service.ts`: Manages configuration by merging defaults, global settings (`settings.json`), and library-specific settings (`library-settings.json`).
-   `paths.service.ts`: Resolves paths to data files (e.g., `database.json`, images), handling both local file paths and remote URLs.
-   `virtualTags.service.ts`: Evaluates user-defined expressions to create "virtual tags" on library items.
-   `startup.service.ts`: Runs synchronously at startup to read the global `settings.json` and determine the library path before any other modules are loaded.


### `src/preload` (Bridge)

This script acts as a secure bridge between the `main` process (Node.js) and the `renderer` process (browser).

-   `index.ts`: Exposes the backend API to the renderer process via `contextBridge` as `window.api`.
-   `index.d.ts`: Provides TypeScript definitions for the `window.api` object for type-safe frontend development.

### `src/renderer` (Frontend)

The user interface of the application, built with Svelte and TypeScript. It runs in a Chromium browser environment.

-   `src/main.ts`: The entry point for the renderer. It mounts the root `App.svelte` component into the DOM.
-   `src/App.svelte`: The top-level Svelte component. Manages global UI state (navigation stack, modals, search results) and listens for real-time updates from the `main` process.
-   `src/components/`: Contains all the Svelte components, organized by function.
    -   `layout/`: High-level components that structure the UI, like `AppHeader`, `MainView`, `ItemDetail`.
    -   `views/`: The different ways to display a list of media items (`GridView`, `ListView`, `TabsView`, etc.). These are the core of the flexible UI engine.
    -   `modals/`: All modal dialogs, like `SettingsModal`, `ItemSettingsModal`, etc.
    -   `ui/`: Reusable, general-purpose UI elements like `SearchInput`, `ContextMenu`, `FilterBar`, and `Dialog`.
-   `src/lib/`: Client-side TypeScript modules (helpers, stores, etc.).
    -   `item-store.ts`: Implements a client-side cache for library items to reduce IPC calls and manage lazy-loading of folder contents.
    -   `shortcuts.ts`: Defines and manages global keyboard shortcuts (e.g., `Ctrl+L` for search).
    -   `dialog-store.ts`: A Svelte store for managing and queuing confirmation and error dialogs.
    -   `autocomplete-manager.ts`: A reusable Svelte action (`use:autocomplete`) for powering suggestion menus in input fields.
    -   `view-state-store.ts`: Svelte stores for managing UI state that needs to persist, like the active tab in a `TabsView`.

### `src/shared` (Shared Code)

This directory contains code that is used by `main`, `preload`, and `renderer`.

-   `types.ts`: Defines all major data structures (`LibraryItem`, `Settings`, etc.) used across the application.
-   `settings-helpers.ts`: Contains the logic for resolving view settings, used by both the backend (to apply defaults) and frontend (to display settings modals).
-   `filter.ts`: Contains the logic for client-side filtering (used by the `FilterBar`).