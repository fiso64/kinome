Tips for Testing:

1. Use eslint/npm run typecheck FIRST. 
2. You can use the `curl` command to test the API.
3. You can use the `sqlite3` command to test the database. I have configured the server to use the library at `./test/media-browser-test-lib/.library/library.db` by default (appdata roaming settings.json points to it, no need to do anything else). Structure of the media-browser-test-lib is as follows:

```
├── .library
│   ├── .ignore
│   ├── images
│   │   ├── ...
│   ├── library-settings.json
│   ├── library.db
│   ├── library.db-shm
│   └── library.db-wal
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
4. Use `pnpm dev` to start the server.
5. Feel free to delete the db file at `./test/media-browser-test-lib/.library/library.db` to start fresh (a rescan can also be triggered by sending the appropriate API call, see the API code for more information).
6. You can use the browser agent yourself to test the webui, assuming rate limits have not been exceeded. If they have, ask me to test it in the browser if needed.
7. Run your own tests using the test suite. Use tsx.
