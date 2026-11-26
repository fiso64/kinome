// Files Bun bundles as text through `import ... with { type: 'text' }`.
declare module 'hls.js/dist/hls.light.min.js' {
  const source: string
  export default source
}
