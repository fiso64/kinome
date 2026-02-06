Tips for Testing:

1. Use `bun run typecheck` FIRST. 
2. There is currently NO tests. (Todo). For now, just test manually.
3. You can use the `Invoke-RestMethod` command to test the API.
4. I have configured the server to use the library at `./test-data/test-lib-small/.library/library.db` by default (appdata roaming settings.json points to it, no need to do anything else, already works). Structure of the test-lib-small is as follows:

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
5. Use `bun dev` to start the server. This will start the frontend on port 3000 and the backend on port 3001.
6. Feel free to delete the db file at `./test-data/test-lib-small/.library/library.db` to start fresh (a rescan can also be triggered by sending the appropriate API call, see the API code for more information).
7. You can use the browser agent yourself to test the webui, assuming rate limits have not been exceeded. If they have, ask me to test it in the browser if needed.
8. If you ever need to save temporary logs, outputs, databases, please don't pollute the base project dir but put them in `./temp`, which is gitignored.
