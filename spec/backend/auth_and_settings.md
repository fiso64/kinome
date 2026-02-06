# Spec: Authentication and Server Settings

**Version:** 1.0
**Status:** Proposed
**Related:** `api_rewrite.md`

---

## 1. Abstract

This feature adds authentication support for the primary administrative account and basic server configuration options (port, allowed IPs). It ensures that the media library and server control operations are secured against unauthorized access, while maintaining compatibility with external media players via tokenized stream URLs.

## 2. Problem Statement / Motivation

Currently, the Kinome server is open to anyone on the network who knows the IP and port. There is no way to restrict access or change the port without modifying the source code. As the project moves towards a more robust client-server model, security and configurability are essential.

- **User Story:** As a user, I want to secure my media library with a password so that only I can access my content remotely.
- **User Story:** As a user, I want to change the port my server runs on to avoid conflicts with other services.

## 3. Goals and Non-Goals

### Goals

- Secure all `/api` endpoints with token-based authentication.
- Create a beautiful, user-friendly login page.
- Persist the authentication token in the browser (`localStorage`).
- Allow users to configure the server port and authorized IP addresses.
- Ensure stream URLs remain functional for external players by supporting token-based authorization.
- Handle "Initial Setup" flow for the admin password and allow changing it later.
- Support an "Unauthenticated Access" mode where no password is required.

### Non-Goals

- Multi-user support (roadmap item, but out of scope for this spec).
- Fine-grained permissions (all-or-nothing admin access for now).
- HTTPS/SSL support (to be handled by reverse proxies).
- Session management across multiple devices (single token per browser for now).

## 4. Proposed Solution & Technical Design

### [UI / Frontend Changes]

- **Login Page:** A dedicated route or overlay for authentication.
- **Auth Store:** A Svelte 5 store (`auth.svelte.ts`) to manage `isAuthenticated`, `token`, and `user` state.
- **API Interceptor:** All network requests from the frontend will include the `Authorization` header.
- **Settings UI:** Add fields for Port and Allowed IPs in the settings modal.

### [API / Backend Changes]

- **Auth Service:** A new service to handle password hashing, token generation, and validation.
- **Auth Middleware:** Express middleware that intercepts all `/api` requests (except `/api/login` and `/api/setup-admin`).
- **IP Filter Middleware:** Middleware to reject requests from IPs not in the `allowedIPs` list (if configured).
- **Stream URLs:** Support `?token=...` query parameter for the `/api/stream/:id` endpoint.

### [Infrastructure / Storage Changes]

- **Settings:**
    - `adminPasswordHash`: Stored in `settings.json`.
    - `allowUnauthenticated`: Boolean, if true, auth middleware is bypassed (except for security-sensitive actions if any).
    - `serverPort`: Default 3000.
    - `allowedIPs`: Array of strings (e.g., `["127.0.0.1", "192.168.1.0/24"]`).

### Example Walkthroughs

**Example 1: Initial Setup**

1. User opens the app for the first time.
2. Frontend detects `adminPassword` is not set via `/api/check-auth`.
3. User is prompted to set an admin password.
4. User submits password; backend hashes it and saves it to `settings.json`.
5. User is automatically logged in.

**Example 2: External Streaming**

1. Frontend generates a stream URL like `http://host:port/api/stream/123/video.mp4?token=xyz`.
2. External player (e.g., VLC) requests the URL.
3. Backend extracts `token` from query string, validates it, and serves the file.

## 5. Edge Cases & Unresolved Questions

- **Password Reset:** No GUI for password reset if forgotten. Manual editing of `settings.json` is required.
- **IP Filtering for Reverse Proxies:** If using a reverse proxy, the server might see the proxy's IP instead of the client's. Users must ensure `X-Forwarded-For` is handled if IP filtering is used.
- **Token Expiry:** For simplicity, tokens will be long-lived or session-based without expiry for now.

## 6. Performance Considerations

- **Impact on Core Operations:** Negligible. Password hashing (Argon2 or bcrypt) only happens on login. Middleware overhead is minimal.
- **Scalability:** The number of authorized tokens is expected to be small (handful of devices).

## 7. Alternatives Considered

- **Alternative A: Basic Auth:** Rejected – poor UX for web apps, harder to style.
- **Alternative B: JWT:** Considered, but simple random tokens are sufficient and easier to manage for now.
