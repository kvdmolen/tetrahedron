<template>
  <div class="timeline-slot" :style="{ height: reservedHeight + 'px' }">
    <div class="timeline-panel" :style="{ height: panelHeight + 'px' }">
      <div class="resize-handle" title="Drag to resize, double-click for the default height" @pointerdown.prevent="startResize" @dblclick="resetHeight" />
      <div class="timeline-content">
        <TimelineEditor
          ref="editor"
          v-model:keyframes="timeline.keyframes"
          v-model:duration="timeline.duration"
          v-model:time="time"
          v-model:loop="timeline.loop"
          v-model:speed="timeline.speed"
          v-model:loop-start="timeline.loopStart"
          v-model:loop-end="timeline.loopEnd"
          :parameters="parameters"
          fill-height
          :min-lane-height="MIN_LANE_HEIGHT_PX"
          :lane-gap="LANE_GAP_PX"
          @output="emit('output', $event)"
        >
          <template #controls>
            <TimelineFileControls
              v-model:name="name"
              :saved-timelines="savedTimelines"
              :can-delete="openedName !== null"
              :unsaved="isUnsaved"
              :error="fileError"
              @new="newTimeline"
              @open="openTimeline"
              @save="saveTimeline"
              @delete="deleteTimeline"
              @refresh="fileAction(refresh)"
            />
          </template>
        </TimelineEditor>
      </div>
    </div>
  </div>
</template>

<script setup>
// The timeline at the bottom of the screen: one lane per model input (INPUTS in shared/tetra.js).
// Its values at the playhead are emitted as 'output' ({ id: value }) on every change, playing or scrubbing.
//
// A timeline is plain JSON, { duration, keyframes, loop, speed, loopStart?, loopEnd? } (see shared/timeline.js).
// Timelines are saved on the server as one <name>.json per timeline; saving under the same name overwrites it,
// saving under a new name makes a copy. The work in progress is also kept in this browser, so a reload loses
// nothing, saved or not.
//
// Drag the strip at the top to make the panel taller (it then overlays the 3D view) or lower; double-click
// it to go back to the default height. The chosen height is remembered.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { INPUTS } from '@shared/tetra.js';
import { cleanTimelineName } from '@shared/timeline.js';
import { useTimelineFiles } from '../composables/useTimelineFiles.js';
import TimelineEditor from './TimelineEditor.vue';
import TimelineFileControls from './TimelineFileControls.vue';

const emit = defineEmits(['output']);

const STORAGE_KEY = 'tetra.timeline';
const NEW_TIMELINE = { duration: 10, keyframes: [] };
const HEIGHT_STORAGE_KEY = 'tetra.timelineHeight';
const MIN_LANE_HEIGHT_PX = 18; // lanes share the panel's height, never lower than this (then they scroll)
const LANE_GAP_PX = 6;
const MIN_HEIGHT_PX = 60;
const TOP_MARGIN_PX = 20; // the panel never covers the very top of the window

// The layout reserves up to the default height (a lower panel gives the 3D view more room);
// a taller panel overlays the 3D view.
const defaultHeight = () => Math.round(Math.max(MIN_HEIGHT_PX, Math.min(440, window.innerHeight * 0.55)));
const clampHeight = (height) => Math.round(Math.max(MIN_HEIGHT_PX, Math.min(window.innerHeight - TOP_MARGIN_PX, height)));
const defaultHeightPx = ref(defaultHeight());
const panelHeight = ref(clampHeight(Number(readStorage(HEIGHT_STORAGE_KEY)) || defaultHeight()));
const reservedHeight = computed(() => Math.min(panelHeight.value, defaultHeightPx.value));

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable (private window)
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: just not remembered
  }
}

function startResize(event) {
  const startY = event.clientY, startHeight = panelHeight.value;
  const onMove = (moveEvent) => (panelHeight.value = clampHeight(startHeight - (moveEvent.clientY - startY)));
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    writeStorage(HEIGHT_STORAGE_KEY, panelHeight.value);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function resetHeight() {
  panelHeight.value = defaultHeight();
  writeStorage(HEIGHT_STORAGE_KEY, panelHeight.value);
}

function onWindowResize() {
  defaultHeightPx.value = defaultHeight();
  panelHeight.value = clampHeight(panelHeight.value);
}
onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));

const parameters = INPUTS.map((input) => ({ id: input.id, name: input.label, range: [input.min, input.max], default: input.base }));

function loadDraft() {
  try {
    const stored = JSON.parse(readStorage(STORAGE_KEY));
    if (Array.isArray(stored?.keyframes)) return stored;
  } catch {
    // no valid stored draft: start empty
  }
  return null;
}

const draft = loadDraft();
const editor = ref(null);

/** What gets saved: loop points only when they have a value. Older files have no loop and speed: off, 1×. */
const timelineContent = ({ duration, keyframes, loop, speed, loopStart, loopEnd }) => ({
  duration,
  keyframes,
  loop: loop ?? false,
  speed: speed ?? 1,
  ...(loopStart != null && { loopStart }),
  ...(loopEnd != null && { loopEnd }),
});

const timeline = ref(timelineContent({ ...NEW_TIMELINE, ...draft }));
const time = ref(0);
const name = ref(draft?.name ?? '');
const openedName = ref(draft?.openedName ?? null); // the saved file this timeline came from, null = none
const baselineJson = ref(draft?.baselineJson ?? null); // content when last opened or saved, to detect changes
const fileError = ref('');

const { savedTimelines, refresh, read, write, remove } = useTimelineFiles();

const contentJson = computed(() => JSON.stringify(timelineContent(timeline.value)));
const isUnsaved = computed(() => contentJson.value !== baselineJson.value || (openedName.value !== null && cleanTimelineName(name.value) !== openedName.value));

watch([contentJson, name, openedName, baselineJson], () => {
  writeStorage(STORAGE_KEY, JSON.stringify({ ...timelineContent(timeline.value), name: name.value, openedName: openedName.value, baselineJson: baselineJson.value }));
});

watch(name, () => (fileError.value = ''));

/** Runs a file action; anything that goes wrong is shown next to the controls. */
async function fileAction(action) {
  fileError.value = '';
  try {
    await action();
  } catch (error) {
    fileError.value = error.message;
  }
}

const confirmDiscard = () => !isUnsaved.value || confirm(`Discard the unsaved changes${name.value ? ` to "${name.value}"` : ''}?`);

/** Show a timeline in the editor; the editor normalizes it, so the baseline is taken after that. */
async function showTimeline(content, newName, newOpenedName) {
  editor.value.pause();
  time.value = 0;
  timeline.value = timelineContent(content);
  name.value = newName;
  openedName.value = newOpenedName;
  await nextTick();
  baselineJson.value = contentJson.value;
}

function newTimeline() {
  if (confirmDiscard()) fileAction(() => showTimeline({ ...NEW_TIMELINE }, '', null));
}

function openTimeline(fileName) {
  if (confirmDiscard()) fileAction(async () => showTimeline(await read(fileName), fileName, fileName));
}

const sameFileName = (a, b) => a?.toLowerCase() === b?.toLowerCase(); // the Mac's file system ignores case

function saveTimeline() {
  return fileAction(async () => {
    const fileName = cleanTimelineName(name.value);
    if (!fileName) throw new Error('Give the timeline a name first');
    await refresh();
    const existing = savedTimelines.value.find((saved) => sameFileName(saved.name, fileName));
    if (existing && !sameFileName(existing.name, openedName.value) && !confirm(`"${existing.name}" already exists. Overwrite it?`)) return;
    const savedContent = contentJson.value;
    await write(fileName, JSON.parse(savedContent));
    name.value = fileName;
    openedName.value = fileName;
    baselineJson.value = savedContent;
    await refresh();
  });
}

/** Deletes the file; the timeline stays on screen, unsaved, so it can still be saved again. */
function deleteTimeline() {
  if (!confirm(`Delete the saved timeline "${openedName.value}"?`)) return;
  fileAction(async () => {
    await remove(openedName.value);
    openedName.value = null;
    baselineJson.value = null;
    await refresh();
  });
}

function onKeyDown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 's') {
    event.preventDefault();
    saveTimeline();
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  if (!draft) {
    await nextTick();
    baselineJson.value = contentJson.value;
  }
  fileAction(refresh);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));
</script>

<style scoped>
.timeline-slot {
  position: relative;
  flex: none;
}

.timeline-panel {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-top: 1px solid var(--panel-border);
  background: var(--panel-solid);
}

.resize-handle {
  position: relative;
  flex: none;
  height: 10px;
  cursor: ns-resize;
  touch-action: none;
}

/* grip */
.resize-handle::after {
  position: absolute;
  top: 3px;
  left: 50%;
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--panel-heading);
  content: '';
  transform: translateX(-50%);
}

.resize-handle:hover::after {
  background: var(--accent);
}

.timeline-content {
  flex: 1;
  min-height: 0;
  padding: 0 16px 8px;
}

/* the editor's colours, from the app theme */
.timeline-panel :deep(.tl) {
  --tl-text: var(--panel-text);
  --tl-muted: var(--panel-label);
  --tl-main-bg: var(--button-bg);
  --tl-lane-bg: var(--track);
  --tl-frame: var(--panel-text);
  --tl-frame-line: var(--panel-heading);
  --tl-point: var(--panel-text);
  --tl-curve: var(--panel-label);
  --tl-hover: var(--warning);
  --tl-selected: var(--accent);
  --tl-playhead: var(--danger);
  font-family: inherit;
}

.timeline-panel :deep(.tl-controls) {
  padding-left: 0;
}

.timeline-panel :deep(.tl-label-lane) {
  font-size: 11px;
}

.timeline-panel :deep(.tl-controls button),
.timeline-panel :deep(.tl-edit button) {
  padding: 4px 10px;
  border: none;
  border-radius: 6px;
  background: var(--button-bg);
  color: var(--panel-text);
  font: inherit;
  cursor: pointer;
}

.timeline-panel :deep(.tl-controls button:disabled) {
  opacity: 0.35;
  cursor: default;
}

.timeline-panel :deep(.tl-time),
.timeline-panel :deep(.tl-edit input) {
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  background: transparent;
  color: var(--panel-text);
}

.timeline-panel :deep(.tl-drag-value) {
  background: var(--page-bg);
  color: var(--panel-text);
}
</style>
