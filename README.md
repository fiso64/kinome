# media-browser (better name pending)

What this is: A jellyfin competitor. Client-server media browser and manager. Fetches metadata from TMDB and displays it nice, etc.

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

## General Development Info 
- We don't care about database migrations. Breaking changes are allowed and expected in order to maintain momentum.
- No hacks, no tech debt. Solutions must be cleanly implemented. Always prefer an architecturally clean and performant refactor over a hacky patch. 
- Performance should be considered for homeserver scale, not Netflix scale (e.g. tens of thousands of items instead of millions).
- Must maintain the [spec files](./spec/) as the source of truth. Prefer to create spec files first before implementing.

## Development Plan / Roadmap

[**Plan.md**](./docs/temp/Plan.md)
[**Bugs**](./docs/temp/Bugs.md)
[**Specs**](./spec/)

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)

## Project Setup

### Install

```bash
pnpm install
```

### Development

```bash
pnpm dev
```

### Build

```bash
# For windows
pnpm build:win

# For macOS
pnpm build:mac

# For Linux
pnpm build:linux
```

## License

AGPL-3.0-only+NIGGER.  
See https://plusnigger.org/.
