// Minimal CDP driver: launches headless Chromium (CHROMIUM), signs in as admin/q at ORIGIN, and evaluates async scripts in the page.
const chromium = process.env.CHROMIUM ?? 'chromium'
const origin = process.env.ORIGIN ?? 'http://localhost:3100'
export async function withPage<T>(run: (evaluate: (code: string) => Promise<any>, logs: string[], send: (method: string, params?: object) => Promise<any>) => Promise<T>, mobile = false): Promise<T> {
  const port = 9300 + Math.floor(Math.random() * 500)
  const profile = `${process.env.TMPDIR ?? '/tmp'}/kinome-bench-profile-${port}`
  const browser = Bun.spawn([chromium, '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio', '--window-size=1280,800', 'about:blank'],
    { stdout: 'ignore', stderr: 'ignore' })
  try {
    let target: any
    for (let i = 0; i < 100 && !target; i++) {
      await Bun.sleep(100)
      target = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).then((l: any[]) => l.find(t => t.type === 'page')).catch(() => undefined)
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
    let id = 0
    const pending = new Map<number, (value: any) => void>()
    const logs: string[] = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id) pending.get(message.id)?.(message)
      if (message.method === 'Runtime.consoleAPICalled') logs.push(message.params.type + ': ' + message.params.args.map((a: any) => a.value ?? JSON.stringify(a.preview?.properties?.map((p: any) => [p.name, p.value]) ?? a.description)).join(' '))
    })
    const send = (method: string, params: object = {}) => new Promise<any>(resolve => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await send('Page.enable')
    const evaluate = async (code: string) => {
      const reply = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
      if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails))
      return reply.result?.result?.value
    }
    await send('Page.navigate', { url: origin + '/' })
    await Bun.sleep(1500)
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'q' }) }).then(r => r.json())
    await evaluate(`localStorage.setItem('auth_token', ${JSON.stringify(login.token)})`)
    await send('Page.navigate', { url: origin + '/' })
    await Bun.sleep(1800)
    return await run(evaluate, logs, send)
  } finally {
    browser.kill()
    await browser.exited
    await Bun.$`rm -rf ${profile}`.quiet().nothrow()
  }
}
