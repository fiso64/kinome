<script lang="ts">
  let { username }: { username: string } = $props()

  // A stable hue per name, so an account looks the same wherever it is listed.
  const hue = $derived.by(() => {
    let hash = 2166136261
    for (let index = 0; index < username.length; index++) {
      hash = Math.imul(hash ^ username.charCodeAt(index), 16777619)
    }
    return (hash >>> 0) * 360 / 2 ** 32
  })
</script>

<span class="avatar" style:--avatar-hue={hue} aria-hidden="true">{username.charAt(0).toUpperCase()}</span>

<style>
  .avatar {
    display: grid;
    place-items: center;
    flex: 0 0 40px;
    width: 40px;
    height: 40px;
    border: 1px solid oklch(0.56 0.09 var(--avatar-hue));
    border-radius: var(--radius-field);
    box-shadow: var(--edge-light);
    color: oklch(0.96 0.025 var(--avatar-hue));
    background: oklch(0.46 0.1 var(--avatar-hue));
    font-size: 1.1rem;
    font-weight: 700;
  }
</style>
