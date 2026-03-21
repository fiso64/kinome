I have configured the server to use the library at `./test-data/test-lib-small/.library/library.db` by default (appdata roaming settings.json points to it, no need to do anything else, already works). Structure of the test-lib-small is as follows:

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
