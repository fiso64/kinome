# Kinome

Media server and manager. Fetches metadata from TMDB and displays it nice, streams media. 

<img width="2539" height="1440" alt="image" src="https://github.com/user-attachments/assets/10dcd0d6-b6de-49fc-a8a4-2260c23a2443" />
<img width="2526" height="1440" alt="image" src="https://github.com/user-attachments/assets/9feb2a6f-7c3a-494c-a1ca-35603a035772" />


### Some features that might be unique to Kinome
- Allows you to keep the folder structure you want instead of forcing you to organize into `tv` and `movies` subdirs.
    - For example, tv show folders can include movies (e.g., because the movie is usually watched after the series, or because you are too lazy to reorganize that torrent). Just navigate into the tv show, right click the movie, then search and assign the correct one.
    - You can put your media into a single dir with mixed shows and movies, or organize into subdirs.
- A virtual/dynamic tag system (inspired by MusicBee) that can be used for searching, home screen organization, or blacklisting/whitelisting certain media for specific users.
- A highly customizable home screen that allows you to group, sort and display media exactly how you want. The home layout above is constructed using a default grouping rule and virtual tags, which are fully configurable. For example, "Animated Movies" is defined as the rule `media type = movie AND genre contains Animation`.
- Easy custom player support. The webui can directly open files in MPV, VLC, or any other player you want after installing a local handler.
- Manual assignment flows for movies/shows/seasons. E.g., when a season folder is misclassified due to non-standard naming, simply right click, search for seasons and select the correct one. 

### Some unavailable features
Kinome is under development and is missing some important features which one would expect to find in a media server. These are planned, but not yet available in the latest version:

- web player
- transcoding/transmuxing
- local ffmpeg metadata extraction and display
- watch mode/automatic library rescans
- scanner currently assumes media folder filename = only the movie/tv show name, so it will fail to find matches automatically if your format differs (e.g., has a year), requiring manual searches.
- any semblance of a polished webui

See [**Plan.md**](./docs/Plan.md) for more details.



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
