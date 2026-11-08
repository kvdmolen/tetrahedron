<template>
  <div class="file-controls">
    <span v-if="error" class="file-error">{{ error }}</span>
    <span v-if="unsaved" class="unsaved" title="Unsaved changes" aria-label="Unsaved changes">●</span>
    <button title="Start a new, empty timeline" @click="emit('new')">New</button>
    <select class="open-select" value="" title="Open a saved timeline" @pointerdown="emit('refresh')" @change="onOpen">
      <option value="" disabled hidden>Open…</option>
      <option v-if="!savedTimelines.length" value="" disabled>No saved timelines yet</option>
      <option v-for="timeline in savedTimelines" :key="timeline.name" :value="timeline.name">{{ timeline.name }} ({{ timeline.duration }} s)</option>
    </select>
    <input v-model="name" class="name-input" type="text" maxlength="80" placeholder="Timeline name" title="Saving under a new name makes a copy" @keydown.enter="emit('save')" />
    <button title="Save under this name (⌘S)" @click="emit('save')">Save</button>
    <button :disabled="!canDelete" title="Delete this saved timeline" @click="emit('delete')">Delete</button>
  </div>
</template>

<script setup>
// File controls for the timeline: new, open, name, save, delete.
const name = defineModel('name', { type: String, required: true });
defineProps({
  savedTimelines: { type: Array, required: true }, // [{ name, duration }]
  canDelete: { type: Boolean, default: false },
  unsaved: { type: Boolean, default: false },
  error: { type: String, default: '' },
});
const emit = defineEmits(['new', 'open', 'save', 'delete', 'refresh']);

function onOpen(event) {
  emit('open', event.target.value);
  event.target.value = ''; // back to "Open…", so the same timeline can be opened again
}
</script>

<style scoped>
.file-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.open-select,
.name-input {
  box-sizing: border-box;
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: transparent;
  color: var(--panel-text);
  font: inherit;
  outline: none;
}

.open-select {
  width: 90px;
  background: var(--button-bg);
  cursor: pointer;
}

.name-input {
  width: 100px;
}

.name-input:focus {
  border-color: var(--accent);
}

.unsaved {
  color: var(--warning);
  white-space: nowrap;
}

.file-error {
  color: var(--danger);
}
</style>
