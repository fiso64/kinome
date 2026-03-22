# Kinome

Media server and manager (like Jellyfin, Plex, Emby, etc.). Fetches metadata from TMDB and displays it nice, streams media.

<img width="2539" height="1440" alt="image" src="https://github.com/user-attachments/assets/12e17cc5-c3c8-45e4-9641-ecadef5445ba" />
<img width="2526" height="1440" alt="image" src="https://github.com/user-attachments/assets/9feb2a6f-7c3a-494c-a1ca-35603a035772" />



## Goals
- More customizable
    - Virtual (automatic) tags which can be used for searching or grouping.
    - Highly customizable per-folder views.
- "Filesystem first":
    - Does not force you to use a particular media folder structure
    - Represents your filesystem.
- Prettier

See Plan.md for more details.

## Development Plan / Roadmap

- [**Plan.md**](./docs/Plan.md)
- [**Bugs**](./docs/Bugs.md)
- [**Specs**](./spec/)

## General Development Info 
- No migration or backward compatibility code (for the database or settings json files). Breaking changes are allowed and expected in order to maintain momentum and avoid unnecessary bloat after feature sprints.
- No hacks, no tech debt. Solutions must be implemented cleanly. Always prefer an architecturally clean and performant refactor over a hacky patch. 
- Performance should be considered for homeserver scale, but not for Netflix scale (i.e. ~tens of thousands of items instead of millions).

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
