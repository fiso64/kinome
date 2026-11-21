<script module lang="ts">
  const paths = {
    brand: 'M5 3H3v18h2M19 3h2v18h-2M9 7v10m0-5 6-5m-6 5 6 5',
    home: 'm3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Zm6 11v-7h6v7',
    search: 'M21 21l-4.5-4.5M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    back: 'm12 5-7 7 7 7M5 12h14',
    left: 'm15 6-6 6 6 6',
    refresh: 'M20 7v5h-5m5 0a8 8 0 0 0-14-5m-2 10v-5h5m-5 0a8 8 0 0 0 14 5',
    grid: 'M3 3h7v7H3zm11 0h7v7h-7zm0 11h7v7h-7zm-11 0h7v7H3z',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
    close: 'm6 6 12 12M18 6 6 18',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4m-4 6h4m8-6h4m-4 6h4',
    file: 'M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7M8 14h8m-8 3h5',
    play: 'm8 5 12 7-12 7V5Z',
    up: 'm6 15 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    right: 'm9 6 6 6-6 6',
    check: 'm5 12 4 4L19 6',
    plus: 'M5 12h14m-7-7v14',
    minus: 'M5 12h14',
    maximize: 'M5 5h14v14H5Z',
    restore: 'M4 8h12v12H4zm4-3V4h12v12h-1',
    user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m12-13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    logout: 'M10 17l5-5-5-5m5 5H3m10-9h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6',
    filter: 'M4 5h16l-6 7v6l-4 2v-8Z',
    clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
    info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v5m0-8h.01',
    warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3h.01',
    grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
    edit: 'm4 16-1 5 5-1L21 7l-4-4L4 16Zm10-10 4 4',
    image: 'M4 4h16v16H4zm0 12 5-5 4 4 3-3 4 4M15 8h.01',
    bolt: 'm13 2-9 12h7l-1 8 10-12h-8l1-8Z',
    eye: 'M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    eyeOff: 'm3 3 18 18M10 6.2c.6-.1 1.3-.2 2-.2 7 0 10 6 10 6s-1.1 2.2-3.8 3.9M7 7.3C3.4 9 2 12 2 12s3 6 10 6c1.5 0 2.8-.3 4-.7M9 10a3 3 0 0 0 4 5',
    sort: 'm3 7 4-4 4 4M7 3v18M13 6h8m-8 6h6m-6 6h4',
    trash: 'M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7',
    block: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM6 6l12 12',
    download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
    tool: 'm14 7 3 3 4-4a6 6 0 0 1-7.5 7.5l-7 7a2 2 0 1 1-3-3l7-7A6 6 0 0 1 18 3l-4 4Z'
  } as const

  export type IconName = keyof typeof paths
</script>

<script lang="ts">
  let { name, size = 20 }: { name: IconName; size?: number } = $props()
</script>

<svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width={name === 'more' || name === 'grip' ? 3 : 1.65} stroke-linecap="round" stroke-linejoin="round">
  <path d={paths[name]} />
</svg>
