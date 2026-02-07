# Kinome

Media server and manager (like Jellyfin, Plex, Emby, etc.). Fetches metadata from TMDB and displays it nice, streams media.

## Goals
- More customizable
    - Virtual (automatic) tags which can be used for searching or grouping.
    - Arbitrarily customizable views. Every single page can be customized as desired.
    - For example: Media can be grouped by user-defined virtual tags. Arbitrarily deep nesting.
- "Filesystem first":
    - Does not force you to use a particular media layout (like a folder for tv shows, a folder for movies)
    - Able to represent your filesystem closely if desired, but not necessarily (as desired)
- Prettier

See Plan.md for more details.

## Development Plan / Roadmap

- [**Plan.md**](./docs/Plan.md)
- [**Bugs**](./docs/Bugs.md)
- [**Specs**](./spec/)

## General Development Info 
- No migration or backwards compatibility code (whether database or json files). Breaking changes are allowed and expected in order to maintain momentum and avoid unnecessary bloat after feature sprints. We are in the unreleased pre-alpha stage of development.
- No hacks, no tech debt. Solutions must be implemented cleanly. Always prefer an architecturally clean and performant refactor over a hacky patch. 
- Performance should be considered for homeserver scale, but not for Netflix scale (i.e. ~tens of thousands of items instead of millions).
- Must maintain the [spec files](./spec/) as the source of truth. Prefer to create spec files first before implementing.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)

## Project Setup

This project uses [Bun](https://bun.sh/) for package management, bundling, and the runtime. Install dependencies:
```bash
bun install
```

### Development

Starts both the backend (Elysia) and frontend (Vite) in watch mode.
```bash
bun run dev
```

### Production Run

Builds the frontend and starts the backend server in production mode.
```bash
bun run prod
```

### Publishing & Packaging

#### Linux

Generate binaries and packages (Debian/RedHat) using `nfpm`.
```bash
# For x64 (Intel/AMD)
bun run publish:linux-x64

# For ARM64 (Raspberry Pi 4/5, etc.)
bun run publish:linux-arm
```

#### Windows

Generate a standalone executable and zip archive.
```bash
bun run publish:win
```