
Let's say I want to make this application also work over the internet. Is there an easy, direct way of turning my main process into a server? It basically already has an API with all the exact commands I need, only that they are sent via IPC and not as requests. 

In the end, I want:
1. good abstractions, no repeated code
2. have both the option to use IPC or a server
3. have good maintainability (adding something new should not be much work)
4. have a separate distributable server binary that I can run on the server. The electron app can be configured to either use the server for remote files, or the built-in IPC communication for local files.

I want to know the overall structure/architecture and how to achieve it (roughly). Do not write any code, only discuss.