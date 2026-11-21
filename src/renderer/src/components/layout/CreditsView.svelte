<script lang="ts">
  import type { LibraryItem } from '@shared/types'
  import Icon from '@components/ui/Icon.svelte'
  import ScrollableGrid from '../views/ScrollableGrid.svelte'

  type Credit = { id: number; name: string; profile_path: string | null; character?: string; job?: string }
  type MoviePerson = {
    id: number
    name: string
    profile_path: string | null
    roles: string[]
    numImportantRoles: number
  }

  let {
    item,
    credits,
    onSearchByTag
  }: {
    item: LibraryItem
    credits: { cast: Credit[]; crew: Credit[] }
    onSearchByTag: (key: string, value: string) => void
  } = $props()

  const isTv = $derived(item.mediaType === 'tv')

  // This logic is now only for movies, which have a different credits structure.
  const IMPORTANT_JOBS_FOR_MOVIE = ['Director', 'Screenplay', 'Writer']

  const processedMovieCredits = $derived.by(() => {
    if (isTv || !credits) return []

    const people = new Map<number, MoviePerson>()

    function addOrUpdatePerson(personData: Credit, role: string, isImportantCrew: boolean) {
      if (!people.has(personData.id)) {
        people.set(personData.id, {
          id: personData.id,
          name: personData.name,
          profile_path: personData.profile_path,
          roles: [],
          numImportantRoles: 0
        })
      }
      const person = people.get(personData.id)!
      if (role) person.roles.push(role)
      if (isImportantCrew) {
        person.numImportantRoles++
      }
    }

    // Process crew
    credits.crew.forEach((crewMember) => {
      if (crewMember.job && IMPORTANT_JOBS_FOR_MOVIE.includes(crewMember.job)) {
        addOrUpdatePerson(crewMember, crewMember.job, true)
      }
    })

    // Process cast
    for (const castMember of credits.cast) {
      addOrUpdatePerson(castMember, castMember.character ?? '', false)
    }

    // Sort by num important roles, then by having an image
    return Array.from(people.values()).sort((a, b) => {
      if (a.numImportantRoles !== b.numImportantRoles) {
        return b.numImportantRoles - a.numImportantRoles
      }
      const aHasImage = !!a.profile_path
      const bHasImage = !!b.profile_path
      if (aHasImage !== bHasImage) {
        return aHasImage ? -1 : 1
      }
      return 0
    })
  })

</script>

{#snippet personCard(person: Credit, roles: string)}
  <button type="button" class="credit-card"
    title={roles ? `${person.name} - ${roles}` : person.name}
    onclick={() => onSearchByTag('person', person.name)}>
    <span class="portrait">
      {#if person.profile_path}
        <img src="https://image.tmdb.org/t/p/w185{person.profile_path}" alt="" loading="lazy" />
      {:else}
        <Icon name="user" size={29} />
      {/if}
    </span>
    <span class="person-name">{person.name}</span>
    {#if roles}<span class="person-roles">{roles}</span>{/if}
  </button>
{/snippet}

<div class="credits-view">
  {#if isTv}
    {#each [{ name: 'Cast', people: credits.cast }, { name: 'Crew', people: credits.crew }] as group (group.name)}
      {#if group.people.length}
        <section aria-label={group.name}>
          <h3>{group.name}</h3>
          <ScrollableGrid stateKey={`credits-${group.name}`} hasItems showScrollbar columnWidth={102}>
            {#each group.people as person (person.id)}
              {@render personCard(person, (person.character ?? person.job ?? '').replaceAll(' / ', ', '))}
            {/each}
          </ScrollableGrid>
        </section>
      {/if}
    {/each}
  {:else}
    <ScrollableGrid stateKey="credits" hasItems={processedMovieCredits.length > 0} showScrollbar columnWidth={110}>
      {#each processedMovieCredits as person (person.id)}
        {@render personCard(person, person.roles.join(', '))}
      {/each}
    </ScrollableGrid>
  {/if}
</div>

<style>
  .credits-view { display: grid; grid-template-columns: minmax(0, 1fr); gap: .8rem; min-width: 0; }
  section { min-width: 0; }
  h3 { font-size: .88rem; font-weight: 650; margin-bottom: .25rem; }
  .credit-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    text-align: left;
    gap: .22rem;
    min-width: 0;
    padding: .3rem;
    background: var(--surface-raised);
    border-color: var(--color-border-soft);
  }
  .credit-card:hover { border-color: var(--accent-border); }
  .portrait {
    display: grid;
    place-items: center;
    overflow: hidden;
    aspect-ratio: 4 / 5;
    background: var(--color-inset);
    color: var(--color-text-dim);
    border-radius: calc(var(--radius-field) - 3px);
  }
  img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .person-name, .person-roles { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .person-name { font-size: .8rem; font-weight: 650; }
  .person-roles { color: var(--color-text-soft); font-size: .72rem; line-height: 1.35; }
</style>
