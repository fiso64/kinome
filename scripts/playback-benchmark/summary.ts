const rows = (await Bun.file(process.argv[2]).text()).trim().split("\n").map(l => JSON.parse(l))
const bad = rows.filter(x => !x.r || x.r.error)
const ok = rows.filter(x => x.r && !x.r.error)
const med = (a: number[]) => { a = a.filter(x => x >= 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN }
const groups: Record<string, Record<string, any[]>> = {}
for (const x of ok) ((groups[`${x.file} ${x.quality} resume=${x.resume}`] ??= {})[x.build] ??= []).push(x.r)
for (const [k, g] of Object.entries(groups)) {
  const f = (b: string) => g[b] ? `n=${g[b].length} ${g[b][0].description?.split(" (")[0]} start ${med(g[b].map(r => r.start))} [${g[b].map(r => r.start).join(",")}] seek ${med(g[b].flatMap(r => r.seeks))} max ${Math.max(...g[b].flatMap(r => r.seeks))} fails ${g[b].flatMap(r => r.seeks).filter((s: number) => s < 0).length} played ${med(g[b].map(r => r.played))} drop ${g[b].reduce((n, r) => n + r.dropped, 0)} warn ${g[b].reduce((n, r) => n + r.warnings.length, 0)}` : "-"
  console.log(k.padEnd(26), "\n   old:", f("old"), "\n   new:", f("new"))
}
console.log("failed runs", bad.length, bad.map(x => `${x.build} ${x.file} ${x.quality} ${x.resume} ${JSON.stringify(x.r)?.slice(0, 120)}`).join("\n"))
