Run `bun run dev:test`, then open `http://localhost:3000`.
It uses `test-data/test-lib-small/.library` and keeps instance settings in
`test-data/.kinome`. The existing fixture has `admin` / `q` and `user` / `q`
accounts. Use Ctrl+C to stop the instance when running in a terminal.

Structure of the test library:

```
├── .library
│   ├── .ignore
│   ├── images
│   │   ├── ...
│   ├── library-settings.json
│   ├── library.db
├── .library.bak
│   ├── ... (use this to restore the library if it gets messed up)
├── Breaking Bad
│   ├── Extras
│   │   └── file.mkv
│   ├── S01
│   │   ├── e01.mkv
│   │   ├── e02.mkv
│   │   └── e03.mkv
│   ├── S02
│   │   ├── e01.mkv
│   │   ├── e02.mkv
│   │   └── e03.mkv
│   └── file.mkv
├── Death Note
│   ├── Extras
│   │   └── file.mkv
│   ├── Other Folder
│   │   └── file.mkv
│   ├── e01.mkv
│   ├── e02.mkv
│   ├── e03.mkv
│   ├── ending-not-an-episode.mkv
│   └── not-an-episode.srt
├── Spirited Away
│   └── movie.mkv
└── The Godfather
    └── godfather.mkv
```
