<script setup>
// 3D view of the sculpture: floor, box, the 10 rope segments, node names.
// Drag to rotate (the front of the box follows the mouse); buttons to zoom and reset the view.
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import AppIcon from './AppIcon.vue';
import { NODE_NAMES, NODE_START_POSITIONS, BOX_CORNERS, BOX_EDGES, FLOOR_CORNERS, CORNER_OF_NODE, SEGMENTS } from '@shared/tetra.js';

const props = defineProps({
  nodes: { type: Array, default: null }, // 4 node positions in model units; null = start positions
});

const DEFAULT_ZOOM = 80; //       pixels per model unit
const ZOOM_STEP = 1.25;
const ZOOM_RANGE = [30, 400];
const PERSPECTIVE_DEPTH = 40; //  larger = flatter perspective
const DRAG_RADIANS_PER_PIXEL = 0.01;
const LABEL_OFFSET_PX = 9;

const canvas = ref(null);
const view = { yaw: 0, pitch: 0, zoom: DEFAULT_ZOOM };
let drag = null;
let resizeObserver = null;
let frameRequest = null;

function rotate([x, y, z]) {
  const cosYaw = Math.cos(view.yaw), sinYaw = Math.sin(view.yaw);
  const cosPitch = Math.cos(view.pitch), sinPitch = Math.sin(view.pitch);
  const x1 = x * cosYaw - y * sinYaw;
  const y1 = x * sinYaw + y * cosYaw;
  return [x1, y1 * cosPitch - z * sinPitch, y1 * sinPitch + z * cosPitch];
}

/** Model point -> canvas pixel. x is horizontal, z vertical (up), y depth (positive = towards the viewer). */
function project(point, width, height) {
  const [x, depth, z] = rotate(point);
  const zoom = view.zoom * (1 + depth / PERSPECTIVE_DEPTH);
  return [width / 2 + x * zoom, height / 2 - z * zoom];
}

function pointOf(end, nodes) {
  return end.node !== undefined ? nodes[end.node] : BOX_CORNERS[end.anchor];
}

function draw() {
  frameRequest = null;
  const element = canvas.value;
  if (!element) return;
  const context = element.getContext('2d');
  const pixelRatio = window.devicePixelRatio || 1;
  const width = element.clientWidth, height = element.clientHeight;
  if (element.width !== Math.round(width * pixelRatio) || element.height !== Math.round(height * pixelRatio)) {
    element.width = Math.round(width * pixelRatio);
    element.height = Math.round(height * pixelRatio);
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineWidth = 2;

  const styles = getComputedStyle(element);
  const line = (from, to, color) => {
    const [x1, y1] = project(from, width, height);
    const [x2, y2] = project(to, width, height);
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  };

  const color = (name) => styles.getPropertyValue(name).trim();

  // floor: half-transparent plane through the bottom corners
  context.fillStyle = color('--floor');
  context.beginPath();
  FLOOR_CORNERS.map((corner) => project(BOX_CORNERS[corner], width, height)).forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
  context.closePath();
  context.fill();

  for (const [a, b] of BOX_EDGES) line(BOX_CORNERS[a], BOX_CORNERS[b], color('--box-line'));
  const nodes = props.nodes ?? NODE_START_POSITIONS;
  for (const segment of SEGMENTS) line(pointOf(segment.from, nodes), pointOf(segment.to, nodes), color('--rope-line'));

  // names: at each node, and (bolder) at its suspension point
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const label = (point, text, font, fillColor) => {
    const [x, y] = project(point, width, height);
    context.font = font;
    context.fillStyle = fillColor;
    context.fillText(text, x + LABEL_OFFSET_PX, y - LABEL_OFFSET_PX);
  };
  NODE_NAMES.forEach((name, node) => {
    label(nodes[node], name, '11px system-ui, sans-serif', color('--node-label'));
    label(BOX_CORNERS[CORNER_OF_NODE[node]], name, '600 14px system-ui, sans-serif', color('--rope-line'));
  });
}

function requestDraw() {
  frameRequest ??= requestAnimationFrame(draw);
}

function onPointerDown(event) {
  drag = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
  event.target.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!drag) return;
  view.yaw = drag.yaw - (event.clientX - drag.x) * DRAG_RADIANS_PER_PIXEL;
  view.pitch = drag.pitch - (event.clientY - drag.y) * DRAG_RADIANS_PER_PIXEL;
  requestDraw();
}

function onPointerUp() {
  drag = null;
}

function zoomBy(factor) {
  view.zoom = Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], view.zoom * factor));
  requestDraw();
}

function resetView() {
  Object.assign(view, { yaw: 0, pitch: 0, zoom: DEFAULT_ZOOM });
  requestDraw();
}

watch(() => props.nodes, requestDraw);

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
onMounted(() => {
  resizeObserver = new ResizeObserver(requestDraw);
  resizeObserver.observe(canvas.value);
  colorScheme.addEventListener('change', requestDraw);
  requestDraw();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  colorScheme.removeEventListener('change', requestDraw);
  if (frameRequest) cancelAnimationFrame(frameRequest);
});
</script>

<template>
  <div class="tetra-view">
    <canvas ref="canvas" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" />
    <div class="view-buttons">
      <button class="button view-button" title="Zoom in" aria-label="Zoom in" @click="zoomBy(ZOOM_STEP)"><AppIcon name="zoomIn" /></button>
      <button class="button view-button" title="Zoom out" aria-label="Zoom out" @click="zoomBy(1 / ZOOM_STEP)"><AppIcon name="zoomOut" /></button>
      <button class="button view-button" title="Reset the view" aria-label="Reset the view" @click="resetView"><AppIcon name="reset" /></button>
    </div>
  </div>
</template>

<style scoped>
.tetra-view {
  position: absolute;
  inset: 0;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

canvas:active {
  cursor: grabbing;
}

.view-buttons {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 4px;
}

.view-button {
  padding: 7px;
  color: var(--panel-text);
}
</style>
