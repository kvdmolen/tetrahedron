<script setup>
// The model runs on the sculpture server; this app draws its state and sends inputs and commands.
// The timeline drives the inputs. The slider panel is kept for fine control later but hidden for now.
import { onMounted, onBeforeUnmount } from 'vue';
import TetraView from './components/TetraView.vue';
import InputPanel from './components/InputPanel.vue';
import MotorPanel from './components/MotorPanel.vue';
import TimelinePanel from './components/TimelinePanel.vue';
import { useSculptureServer } from './composables/useSculptureServer.js';

const SHOW_INPUT_SLIDERS = false;

const { connected, mock, state, inputs, messages, send } = useSculptureServer();

function applyTimelineValues(values) {
  Object.assign(inputs, values);
}

// Space bar = emergency stop (unless typing in a text field)
function onKeyDown(event) {
  if (event.code !== 'Space' || event.target.matches?.('input[type=text], input[type=number], textarea')) return;
  event.preventDefault();
  send('emergencyStop');
}
onMounted(() => window.addEventListener('keydown', onKeyDown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown));
</script>

<template>
  <div class="layout">
    <div class="view-area">
      <TetraView :nodes="state.nodes" />
    </div>
    <TimelinePanel @output="applyTimelineValues" />
  </div>
  <MotorPanel :connected="connected" :mock="mock" :state="state" :messages="messages" @command="send" />
  <InputPanel
    v-if="SHOW_INPUT_SLIDERS"
    v-model:inputs="inputs"
    :simulation-running="state.simulationRunning"
    @toggle-simulation="send('setSimulationRunning', { running: !state.simulationRunning })"
    @reset="send('resetModel')"
  />
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.view-area {
  position: relative;
  flex: 1;
  min-height: 0;
}
</style>
