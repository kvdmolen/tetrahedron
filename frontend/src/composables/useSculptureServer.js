import { reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { defaultInputValues } from '@shared/tetra.js';

// While the user is dragging, local slider values win over the (slightly older) values echoed by the server.
const LOCAL_EDIT_PRIORITY_MS = 500;
const RECONNECT_DELAY_MS = 1000;
const MAX_MESSAGES = 6;

/**
 * Connection to the sculpture server. The model runs there; this keeps a live copy of its state
 * and sends the input values and commands.
 *
 *   const { connected, state, inputs, messages, send } = useSculptureServer()
 *   inputs is two-way: change a value and it is sent; changes from elsewhere (other screens, homing) come in.
 */
export function useSculptureServer() {
  const connected = ref(false);
  const mock = ref(false);
  const state = ref({ nodes: null, motorState: 'disconnected', homed: false, synced: false, activity: '', simulationRunning: true, overrunCount: 0, ropes: [] });
  const inputs = reactive(defaultInputValues());
  const messages = ref([]); // newest first: { kind: 'log' | 'error', text }

  let socket = null;
  let reconnectTimer = null;
  let lastSyncedInputsJson = JSON.stringify(inputs);
  let lastLocalEditMs = 0;

  function addMessage(kind, text) {
    messages.value = [{ kind, text }, ...messages.value].slice(0, MAX_MESSAGES);
  }

  function send(type, data = {}) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data }));
    else addMessage('error', 'Not connected to the server');
  }

  function applyServerState(serverState) {
    state.value = serverState;
    const serverInputsJson = JSON.stringify(serverState.inputs);
    if (serverInputsJson !== lastSyncedInputsJson && performance.now() - lastLocalEditMs > LOCAL_EDIT_PRIORITY_MS) {
      lastSyncedInputsJson = serverInputsJson;
      Object.assign(inputs, serverState.inputs);
    }
  }

  function onMessage(message) {
    if (message.type === 'hello') mock.value = message.mock;
    else if (message.type === 'state') applyServerState(message);
    else if (message.type === 'log') addMessage('log', message.text);
    else if (message.type === 'error') addMessage('error', message.message);
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws`);
    socket.onopen = () => {
      connected.value = true;
      lastLocalEditMs = 0; // take over the server's current inputs
    };
    socket.onclose = () => {
      connected.value = false;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    socket.onmessage = (event) => onMessage(JSON.parse(event.data));
  }

  watch(inputs, () => {
    const inputsJson = JSON.stringify(inputs);
    if (inputsJson === lastSyncedInputsJson) return; // came from the server
    lastSyncedInputsJson = inputsJson;
    lastLocalEditMs = performance.now();
    if (socket?.readyState === WebSocket.OPEN) send('setInputs', { inputs: { ...inputs } }); // 'no server' shows otherwise
  });

  onMounted(connect);
  onBeforeUnmount(() => {
    clearTimeout(reconnectTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  });

  return { connected, mock, state, inputs, messages, send };
}
