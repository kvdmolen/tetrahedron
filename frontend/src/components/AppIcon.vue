<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    :fill="icon.filled ? 'currentColor' : 'none'"
    :stroke="icon.filled ? 'none' : 'currentColor'"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="icon.path" />
  </svg>
</template>

<script setup>
// Small icons, drawn in the text colour. Add one by adding its path to ICONS.
import { computed } from 'vue';

const props = defineProps({
  name: { type: String, required: true },
});

const MAGNIFIER = 'M11 3a8 8 0 1 0 0 16a8 8 0 0 0 0-16zM21 21l-4.3-4.3';
const ICONS = {
  play: { path: 'M6 4l14 8-14 8z', filled: true },
  pause: { path: 'M6 4h4v16H6zM14 4h4v16h-4z', filled: true },
  reset: { path: 'M1 4v6h6M3.5 15a9 9 0 1 0 2.1-9.4L1 10' }, // a circle arrow turning backwards
  zoomIn: { path: `${MAGNIFIER}M11 8v6M8 11h6` },
  zoomOut: { path: `${MAGNIFIER}M8 11h6` },
  fit: { path: 'M3 3l6 6M3 8V3h5M21 3l-6 6M16 3h5v5M3 21l6-6M3 16v5h5M21 21l-6-6M16 21h5v-5' }, // four arrows outward
};

const icon = computed(() => ICONS[props.name]);
</script>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
