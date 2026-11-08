<script setup>
// Motor controls and status: connect, home, start/stop streaming, emergency stop, per-rope table.
import { computed } from 'vue';

const props = defineProps({
  connected: { type: Boolean, required: true },
  mock: { type: Boolean, default: false },
  state: { type: Object, required: true },
  messages: { type: Array, default: () => [] },
});
const emit = defineEmits(['command']);

const motorState = computed(() => props.state.motorState);
const isBusy = computed(() => ['connecting', 'homing', 'syncing'].includes(motorState.value));

function home() {
  const again = props.state.homed ? 'The motors are already homed; if this homing is stopped halfway, that homing still holds.\n\n' : '';
  const confirmed = confirm(`${again}Homing: all motors pull softly; one rope at a time winds in slowly until its end reaches its exit point. Then a slow transition takes the sculpture to the simulation's pose, and it follows the simulation.\n\nKeep hands clear of the ropes. Start?`);
  if (confirmed) emit('command', 'home');
}

function homeHere() {
  const confirmed = confirm('Home here (for testing WITHOUT ropes): every motor counts as being at the simulation\'s current pose, no homing.\n\nWith ropes attached this is wrong and the motors would fight. Only without ropes. Continue?');
  if (confirmed) emit('command', 'homeHere');
}

// homed: every motor's position known (kept until a motor loses power); synced: the motors follow the simulation
const motorStatus = computed(() => {
  if (motorState.value === 'disconnected') return null;
  if (motorState.value === 'homing') return { text: 'homing…', kind: 'busy' };
  if (motorState.value === 'syncing') return { text: 'TRANSITION…', kind: 'busy' };
  if (props.state.synced) return { text: 'SYNCED', kind: 'synced', hint: 'view shows the sculpture: behind the sliders' };
  if (props.state.homed) return { text: 'HOMED', kind: 'homed', hint: 'motors hold; the simulation runs on its own' };
  return { text: 'NOT HOMED', kind: 'not-homed' };
});

const homingStep = computed(() => (motorState.value === 'homing' ? props.state.homingStep : null));
const homing = (action, mm) => emit('command', 'homingAction', { action, mm });

function ropeTitle(rope) {
  const kind = rope.isTension ? `constant-tension rope${rope.tensionCurrentA !== null ? `, ${rope.tensionCurrentA} A` : ''}` : 'position rope';
  return rope.limited ? `${kind}, at its length limit` : kind;
}
</script>

<template>
  <div class="panel motor-panel">
    <div class="panel-header">
      <span class="panel-title">MOTORS</span>
      <span class="connection" :class="{ online: connected }">{{ connected ? (mock ? 'server · simulated' : 'server') : 'no server' }}</span>
    </div>

    <button class="emergency-stop" title="Space bar" @click="emit('command', 'emergencyStop')">EMERGENCY STOP</button>

    <div class="status-row">
      <span class="status-label">state</span><span>{{ motorState }}</span>
    </div>
    <div v-if="motorStatus" class="status-row" :title="motorStatus.hint">
      <span class="status-label">motors</span><span class="motor-status" :class="motorStatus.kind">{{ motorStatus.text }}</span>
    </div>
    <div v-if="state.activity" class="status-row"><span class="status-label" /><span>{{ state.activity }}</span></div>
    <div v-if="homingStep" class="homing-controls">
      <template v-if="homingStep.phase === 'confirm'">
        <div class="jog-row">
          <button class="button" title="Wind in a little: the end is further in" @click="homing('jog', -homingStep.jogMm)">− {{ homingStep.jogMm }} mm</button>
          <span class="adjust">{{ homingStep.adjustMm > 0 ? '+' : '' }}{{ homingStep.adjustMm }} mm</span>
          <button class="button" title="Give a little rope: the end is further out" @click="homing('jog', homingStep.jogMm)">+ {{ homingStep.jogMm }} mm</button>
        </div>
        <div class="button-grid">
          <button class="button" title="Not the end yet: give some slack, then wind in again" @click="homing('retry')">Continue winding</button>
          <button class="button confirm" title="This is the end: next rope" @click="homing('confirm')">Confirm</button>
        </div>
      </template>
      <button v-if="homingStep.phase === 'paused'" class="button confirm wide" @click="homing('resume')">Resume homing</button>
      <button v-else class="button wide" :disabled="homingStep.phase === 'busy'" title="Pause homing: ropes give way, e.g. to untangle" @click="homing('pause')">Stop</button>
    </div>
    <div v-if="motorState === 'streaming'" class="status-row">
      <span class="status-label">late ticks</span><span>{{ state.overrunCount }}</span>
    </div>

    <div class="button-grid">
      <button v-if="motorState === 'disconnected'" class="button" @click="emit('command', 'connectMotors')">Connect</button>
      <button v-else class="button" :disabled="isBusy" @click="emit('command', 'disconnectMotors')">Disconnect</button>
      <button class="button" :disabled="motorState !== 'idle'" @click="home">{{ state.homed ? 'Home again' : 'Home' }}</button>
      <button class="button" :disabled="motorState !== 'idle'" title="Testing without ropes: count the motors as homed where they are, at the simulation's pose" @click="homeHere">Home here</button>
      <button class="button" :disabled="motorState !== 'idle' || !state.homed" title="Transition to the simulation's pose, then follow it" @click="emit('command', 'startMotors')">Start motors</button>
      <button class="button" :disabled="!['syncing', 'streaming'].includes(motorState)" title="Motors hold; the simulation runs on its own" @click="emit('command', 'stopMotors')">Stop motors</button>
    </div>

    <div class="messages">
      <div v-for="(message, index) in messages" :key="index" :class="message.kind">{{ message.text }}</div>
    </div>

    <details class="rope-table">
      <summary>Ropes</summary>
      <table>
        <thead>
          <tr><th>ID</th><th>rope</th><th>free</th><th>wound</th><th>turns</th></tr>
        </thead>
        <tbody>
          <tr v-for="rope in state.ropes" :key="rope.name" :class="{ disabled: !rope.enabled, limited: rope.limited, tension: rope.isTension }" :title="ropeTitle(rope)">
            <td>{{ rope.motorId }}</td>
            <td>{{ rope.name }}{{ rope.isTension ? ' T' : '' }}</td>
            <td>{{ rope.freeLengthMm }}</td>
            <td>{{ rope.woundLengthMm }}</td>
            <td>{{ rope.revolutions.toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="hint">mm; turns from an empty drum; T = constant tension (hover for current); faded = not connected</div>
    </details>
  </div>
</template>

<style scoped>
.motor-panel {
  left: 20px;
  width: 240px;
}

.connection {
  color: var(--danger);
  font-size: 10px;
}

.connection.online {
  color: var(--panel-label);
}

.emergency-stop {
  width: 100%;
  margin-bottom: 10px;
  padding: 10px 0;
  border: none;
  border-radius: 8px;
  background: var(--danger);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
}

.emergency-stop:active {
  filter: brightness(0.8);
}

.status-row {
  display: flex;
  gap: 6px;
  margin: 3px 0;
  font-size: 11px;
}

.motor-status {
  font-weight: 700;
  letter-spacing: 0.04em;
}

.motor-status.synced {
  color: var(--ok);
}

.motor-status.homed {
  color: var(--accent);
}

.motor-status.not-homed {
  color: var(--danger);
}

.motor-status.busy {
  color: var(--panel-label);
}

.status-label {
  width: 60px;
  flex-shrink: 0;
  color: var(--panel-label);
}

.homing-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.homing-controls .button-grid {
  margin: 0;
}

.jog-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 6px;
}

.adjust {
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.button.confirm {
  background: var(--accent);
  color: #fff;
}

.button.wide {
  width: 100%;
}

.button-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin: 10px 0;
}

.messages {
  color: var(--panel-label);
  font-size: 10px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;
}

.messages .error {
  color: var(--danger);
}

.rope-table {
  margin-top: 10px;
  font-size: 10px;
}

.rope-table summary {
  color: var(--panel-heading);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
}

table {
  width: 100%;
  margin-top: 4px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

th {
  color: var(--panel-label);
  font-weight: 400;
}

th,
td {
  padding: 1px 0;
  text-align: right;
}

th:nth-child(-n + 2),
td:nth-child(-n + 2) {
  text-align: left;
}

td:first-child {
  padding-right: 4px;
  color: var(--panel-label);
}

tr.tension td:nth-child(2) {
  font-weight: 600;
}

tr.limited td {
  color: var(--warning);
}

tr.disabled {
  opacity: 0.35;
}

.hint {
  margin-top: 4px;
  color: var(--panel-heading);
}
</style>
