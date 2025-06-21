<script lang="ts">
  type Person = {
    id: number
    name: string
    profile_path: string | null
    roles: string[]
    importance: number // The MOST important role they have (lower is better)
    numImportantRoles: number // How many important roles they have
    originalOrder: number // To preserve TMDB's sorting for actors
  }

  let { credits }: { credits: { cast: any[]; crew: any[] } } = $props()

  const IMPORTANT_JOBS = ['Creator', 'Director', 'Screenplay', 'Writer']

  const processedCredits = $derived.by(() => {
    if (!credits) return []

    const people = new Map<number, Person>()

    // Helper to add a person or update their roles and importance
    function addOrUpdatePerson(personData: any, role: string, importance: number, order: number) {
      if (!people.has(personData.id)) {
        people.set(personData.id, {
          id: personData.id,
          name: personData.name,
          profile_path: personData.profile_path,
          roles: [],
          importance: Infinity,
          numImportantRoles: 0,
          originalOrder: Infinity
        })
      }
      const person = people.get(personData.id)!
      person.roles.push(role)

      // An importance of 100 is for actors, which we don't count as an "important job" for this purpose.
      if (importance < 100) {
        person.numImportantRoles++
      }

      // Update importance only if the new role is more important (lower number)
      if (importance < person.importance) {
        person.importance = importance
        person.originalOrder = order
      }
    }

    // Process crew for important jobs first
    credits.crew.forEach((crewMember, index) => {
      const jobIndex = IMPORTANT_JOBS.indexOf(crewMember.job)
      if (jobIndex !== -1) {
        // Importance is based on the order in IMPORTANT_JOBS.
        // The original order is just the index in the crew array.
        addOrUpdatePerson(crewMember, crewMember.job, jobIndex, index)
      }
    })

    // Process cast members
    for (const castMember of credits.cast) {
      // Give all cast members an importance of 100.
      // Their `originalOrder` comes from TMDB's `order` property.
      addOrUpdatePerson(castMember, castMember.character, 100, castMember.order)
    }

    // Sort by number of important roles (desc), then importance (asc), then original TMDB order (asc)
    return Array.from(people.values()).sort((a, b) => {
      if (a.numImportantRoles !== b.numImportantRoles) {
        return b.numImportantRoles - a.numImportantRoles // Higher count first
      }
      if (a.importance !== b.importance) {
        return a.importance - b.importance
      }
      return a.originalOrder - b.originalOrder
    })
  })

  function horizontalScroll(event: WheelEvent) {
    if (event.deltaY === 0) return
    event.preventDefault()
    const element = event.currentTarget as HTMLElement
    element.scrollLeft += event.deltaY
  }
</script>

<div class="credits-view-container">
  <h2 class="section-title">Cast & Crew</h2>
  <div class="credits-list" onwheel={horizontalScroll}>
    {#each processedCredits as person (person.id)}
      <div
        class="credit-item"
        data-name={person.name}
        data-roles={person.roles.join(' \u2022 ')}
      >
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
        <!-- Static content, visible by default -->
        <div class="credit-info static">
          <div class="person-name">{person.name}</div>
          <div class="person-roles">{person.roles.join(', ')}</div>
        </div>
        <!-- Pop-up content, hidden by default and revealed on hover -->
        <div class="credit-info popup">
          <div class="person-name">{person.name}</div>
          <div class="person-roles">{person.roles.join(' • ')}</div>
        </div>
      </div>
    {/each}
  </div>
</div>

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