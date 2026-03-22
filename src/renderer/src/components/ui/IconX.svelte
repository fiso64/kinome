<script lang="ts">
  let { size = 12, stroke = 'currentColor' }: { size?: number; stroke?: string } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 12 12"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
>
  <path d="M2 2L10 10M10 2L2 10" stroke={stroke} stroke-width="1.5" stroke-linecap="round" />
</svg>
