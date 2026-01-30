
Tips for Testing:

1. You can use the `curl` command to test the API.
2. You can use the `sqlite3` command to test the database. I have configured the server to use the library at `./test/media-browser-test-lib/.library/library.db` by default.
3. Use `pnpm dev` to start the server.
4. Use the linter to check for errors.
5. Feel free to delete the db file at `./test/media-browser-test-lib/.library/library.db` to start fresh (a rescan can also be triggered by sending the appropriate API call, see the API code for more information).
6. You can use the browser agent yourself to test the webui, assuming rate limits have not been exceeded. If they have, ask me to test it in the browser if needed.