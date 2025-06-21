<script lang="ts">
  type Person = {
    id: number
    name: string
    profile_path: string | null
    roles: string[]
    importance: number // Lower is more important
  }

  let { credits }: { credits: { cast: any[]; crew: any[] } } = $props()

  const IMPORTANT_JOBS = ['Director', 'Screenplay', 'Writer']

  const processedCredits = $derived.by(() => {
    if (!credits) return []

    const people = new Map<number, Person>()

    // Helper to add a person or update their roles
    function addOrUpdatePerson(personData: any, role: string, importance: number) {
      if (!people.has(personData.id)) {
        people.set(personData.id, {
          id: personData.id,
          name: personData.name,
          profile_path: personData.profile_path,
          roles: [],
          importance: Infinity // Default to least important
        })
      }
      const person = people.get(personData.id)!
      person.roles.push(role)
      // Update importance only if the new role is more important
      person.importance = Math.min(person.importance, importance)
    }

    // Process crew
    for (const crewMember of credits.crew) {
      const jobIndex = IMPORTANT_JOBS.indexOf(crewMember.job)
      if (jobIndex !== -1) {
        // Importance based on order in IMPORTANT_JOBS array
        addOrUpdatePerson(crewMember, crewMember.job, jobIndex)
      }
    }

    // Process cast
    for (const castMember of credits.cast) {
      // All cast members have an importance of 100
      addOrUpdatePerson(castMember, castMember.character, 100)
    }

    // Sort by importance, then by name for tie-breaking
    return Array.from(people.values()).sort((a, b) => {
      if (a.importance !== b.importance) {
        return a.importance - b.importance
      }
      return a.name.localeCompare(b.name)
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
      <div class="credit-item">
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
        <div class="credit-info">
          <div class="person-name">{person.name}</div>
          <div class="person-roles">{person.roles.join(', ')}</div>
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
    gap: 1.5rem;
    padding: 0.5rem 0 1.5rem 0; /* Padding for scrollbar and breathing room */
    -ms-overflow-style: none; /* for Internet Explorer, Edge */
    scrollbar-width: none; /* for Firefox */
  }
  .credits-list::-webkit-scrollbar {
    display: none; /* for Chrome, Safari, and Opera */
  }
  .credit-item {
    display: flex;
    flex-direction: column;
    width: 140px;
    flex-shrink: 0;
    gap: 0.5rem;
    transition: transform 0.2s ease-out;
  }
  .credit-item:hover {
    transform: scale(1.05);
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
    min-height: 3.5em; /* Reserve space for at least two lines of roles */
    position: relative;
    transition: all 0.2s ease-out;
  }
  .credit-item:hover .credit-info {
    position: absolute;
    bottom: -0.5rem; /* Pop out from bottom */
    left: -0.75rem;
    right: -0.75rem;
    background: var(--color-background);
    padding: 0.75rem;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    z-index: 10;
  }

  .person-name {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .person-roles {
    font-size: 0.8rem;
    color: var(--ev-c-text-2);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: normal; /* Allow wrapping */
  }
  .credit-item:hover .person-roles {
    -webkit-line-clamp: unset; /* Remove line clamp on hover */
    max-height: none;
  }
</style>