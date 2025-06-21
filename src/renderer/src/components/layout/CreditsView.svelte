<script lang="ts">
  type MoviePerson = {
    id: number
    name: string
    profile_path: string | null
    roles: string[]
    numImportantRoles: number
  }

  let { item, credits }: { item: LibraryItem; credits: { cast: any[]; crew: any[] } } = $props()

  const isTv = $derived(item.mediaType === 'tv')

  // This logic is now only for movies, which have a different credits structure.
  const IMPORTANT_JOBS_FOR_MOVIE = ['Director', 'Screenplay', 'Writer']

  const processedMovieCredits = $derived.by(() => {
    if (isTv || !credits) return []

    const people = new Map<number, MoviePerson>()

    function addOrUpdatePerson(personData: any, role: string, isImportantCrew: boolean) {
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
      person.roles.push(role)
      if (isImportantCrew) {
        person.numImportantRoles++
      }
    }

    // Process crew
    credits.crew.forEach((crewMember) => {
      if (IMPORTANT_JOBS_FOR_MOVIE.includes(crewMember.job)) {
        addOrUpdatePerson(crewMember, crewMember.job, true)
      }
    })

    // Process cast
    for (const castMember of credits.cast) {
      addOrUpdatePerson(castMember, castMember.character, false)
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

  function horizontalScroll(event: WheelEvent) {
    if (event.deltaY === 0) return
    event.preventDefault()
    const element = event.currentTarget as HTMLElement
    element.scrollLeft += event.deltaY
  }
</script>

{#snippet personTemplate(person, roles, popupRoles)}
  <div class="credit-item" data-name={person.name} data-roles={popupRoles}>
    <div class="credit-poster">
      {#if person.profile_path}
        <img
          src="https://image.tmdb.org/t/p/w185{person.profile_path}"
          alt={person.name}
          loading="lazy"
        />
      {:else}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="icon"
        >
          <path
            d="M12 2.5a5.5 5.5 0 0 1 3.096 10.047 9.005 9.005 0 0 1 5.9 8.181.75.75 0 0 1-1.498.07 7.5 7.5 0 0 0-14.992 0 .75.75 0 0 1-1.5-.07 9.005 9.005 0 0 1 5.9-8.181A5.5 5.5 0 0 1 12 2.5ZM8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0Z"
          ></path>
        </svg>
      {/if}
    </div>
    <div class="credit-info static">
      <div class="person-name">{person.name}</div>
      <div class="person-roles">{roles}</div>
    </div>
    <div class="credit-info popup">
      <div class="person-name">{person.name}</div>
      <div class="person-roles">{popupRoles}</div>
    </div>
  </div>
{/snippet}

{#if isTv}
  <div class="credits-view-container">
    {#if credits.cast?.length > 0}
      <h2 class="section-title">Cast</h2>
      <div class="credits-list" onwheel={horizontalScroll}>
        {#each credits.cast as person (person.id)}
          {@const roles = person.character}
          {@const popupRoles = roles.replace(/ \/ /g, ' • ')}
          {@render personTemplate(person, roles, popupRoles)}
        {/each}
      </div>
    {/if}
    {#if credits.crew?.length > 0}
      <h2 class="section-title">Crew</h2>
      <div class="credits-list" onwheel={horizontalScroll}>
        {#each credits.crew as person (person.id)}
          {@const roles = person.job}
          {@const popupRoles = roles.replace(/ \/ /g, ' • ')}
          {@render personTemplate(person, roles, popupRoles)}
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <div class="credits-view-container">
    <h2 class="section-title">Cast & Crew</h2>
    <div class="credits-list" onwheel={horizontalScroll}>
      {#each processedMovieCredits as person (person.id)}
        {@const roles = person.roles.join(', ')}
        {@const popupRoles = person.roles.join(' • ')}
        {@render personTemplate(person, roles, popupRoles)}
      {/each}
    </div>
  </div>
{/if}

<style>
  .credits-view-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    grid-column: 1 / -1; /* Span full width of the parent grid */
  }
  .section-title {
    font-size: 1.5rem;
    font-weight: bold;
    border-bottom: 1px solid var(--color-background-mute);
    padding-bottom: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .credits-list {
    display: flex;
    overflow-x: auto;
    overflow-y: visible; /* Fix #1: Allow vertical overflow to show pop-up */
    gap: 1.5rem;
    padding: 0.5rem;
    padding-bottom: 5rem;
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .credits-list::-webkit-scrollbar {
    display: none;
  }
  .credit-item {
    display: flex;
    flex-direction: column;
    width: 100px;
    flex-shrink: 0;
    gap: 0.5rem;
    position: relative;
  }
  .credit-item:hover {
    z-index: 10;
  }
  .credit-poster {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background-color: var(--color-background-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
    transition: transform 0.2s ease-out;
  }
  .credit-item:hover .credit-poster {
    transform: scale(1.05);
  }
  .credit-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icon {
    width: 50%;
    height: 50%;
    color: var(--ev-c-gray-1);
  }

  .credit-info {
    padding: 0 0.25rem;
  }
  .credit-info.static {
    min-height: 3.5em;
    width: 100%;
    transition: opacity 0.1s ease-out;
  }
  .credit-item:hover .credit-info.static {
    opacity: 0;
  }
  .credit-info.popup {
    position: absolute;
    top: calc(100px * 3 / 2 + 0.5rem);
    left: 50%;
    width: 180px;

    background: var(--color-background);
    padding: 0.75rem;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);

    opacity: 0;
    transform: translate(-50%, -10px) scale(0.95);
    pointer-events: none;
    transition:
      transform 0.2s ease-out,
      opacity 0.2s ease-out;
  }
  .credit-item:hover .credit-info.popup {
    opacity: 1;
    transform: translate(-50%, 0) scale(1);
    pointer-events: auto;
  }

  .person-name {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Style both static and popup roles */
  .person-roles {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
    line-height: 1.4;
    white-space: normal; /* Allow wrapping */
  }

  /* Only clamp lines on the static version */
  .credit-info.static .person-roles {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Adjust popup positioning for first and last items to prevent clipping at container edges */
  .credit-item:first-child .credit-info.popup {
    /* For the first item, align popup to the left */
    left: 0;
    transform: translate(0, -10px) scale(0.95);
  }
  .credit-item:first-child:hover .credit-info.popup {
    transform: translate(0, 0) scale(1);
  }
  .credit-item:last-child .credit-info.popup {
    /* For the last item, align popup to the right */
    left: auto;
    right: 0;
    transform: translate(0, -10px) scale(0.95);
  }
  .credit-item:last-child:hover .credit-info.popup {
    transform: translate(0, 0) scale(1);
  }
</style>