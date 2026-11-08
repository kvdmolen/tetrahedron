import { ref } from 'vue';

/** Saved timelines on the sculpture server (backend/src/timelineApi.js). */
export function useTimelineFiles() {
  const savedTimelines = ref([]); // [{ name, duration }]

  async function request(path = '', options) {
    let response;
    try {
      response = await fetch(`/api/timelines${path}`, options);
    } catch {
      throw new Error('No connection to the server');
    }
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      throw new Error(error ?? `The server answered ${response.status}`);
    }
    return response.status === 204 ? null : response.json();
  }

  const pathOf = (name) => `/${encodeURIComponent(name)}`;

  return {
    savedTimelines,
    async refresh() {
      savedTimelines.value = await request();
    },
    read: (name) => request(pathOf(name)),
    write: (name, timeline) => request(pathOf(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(timeline) }),
    remove: (name) => request(pathOf(name), { method: 'DELETE' }),
  };
}
