<template>
  <div class="panel input-panel">
    <div class="panel-header">
      <span class="panel-title">TETRA</span>
      <div class="header-buttons">
        <button class="button" @click="emit('reset')">Reset</button>
        <button class="button" :class="{ active: simulationRunning }" @click="emit('toggleSimulation')">
          {{ simulationRunning ? '■ Stop' : '▶ Run' }}
        </button>
      </div>
    </div>

    <template v-for="group in groups" :key="group.title">
      <div class="section-title">{{ group.title }}</div>
      <label v-for="input in group.inputs" :key="input.id" class="slider-row">
        <span class="slider-label">{{ input.label }}</span>
        <span class="slider-track">
          <input
            v-model.number="inputs[input.id]"
            type="range"
            :min="input.min"
            :max="input.max"
            step="0.01"
            title="double-click: back to 0"
            @dblclick="inputs[input.id] = input.base"
          />
        </span>
        <span class="slider-value">{{ formatValue(inputs[input.id]) }}</span>
      </label>
    </template>
  </div>
</template>

<script setup>
// One slider per model input, grouped as in shared/tetra.js (INPUTS is the single source).
// All run -1..1 with 0 = rest (marked); double-click a slider to reset it.
import { INPUTS } from '@shared/tetra.js';

const inputs = defineModel('inputs', { type: Object, required: true });
defineProps({
  simulationRunning: { type: Boolean, default: true },
});
const emit = defineEmits(['toggleSimulation', 'reset']);

const GROUP_TITLES = { suspension: 'Suspension', connection: 'Connection', shape: 'Shape' };
const formatValue = (value) => (value > 0 ? '+' : '') + value.toFixed(2);

const groups = Object.entries(GROUP_TITLES)
  .map(([group, title]) => ({ title, inputs: INPUTS.filter((input) => input.group === group) }))
  .filter((group) => group.inputs.length);
  
</script>

<style scoped>
.input-panel {
  right: 20px;
  width: 240px;
}

.header-buttons {
  display: flex;
  gap: 6px;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0;
}

.slider-label {
  width: 30px;
  flex-shrink: 0;
  color: var(--panel-label);
  font-size: 10px;
}

.slider-value {
  width: 36px;
  flex-shrink: 0;
  color: var(--panel-heading);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.slider-track {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

/* mark at 0 (the middle of the -1..1 range) */
.slider-track::before {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 1px;
  height: 8px;
  background: var(--panel-heading);
  content: '';
  transform: translate(-50%, -50%);
}

input[type='range'] {
  position: relative;
  flex: 1;
  min-width: 0;
  margin: 6px 0;
  height: 2px;
  border-radius: 2px;
  background: var(--track);
  outline: none;
  cursor: pointer;
  appearance: none;
}

input[type='range']::-webkit-slider-thumb {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--thumb);
  appearance: none;
}

input[type='range']::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border: none;
  border-radius: 50%;
  background: var(--thumb);
}
</style>
