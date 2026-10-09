#!/usr/bin/env node
// Tetra server: runs the rope model + motors, serves the frontend, talks to it over a WebSocket.
//
//   node src/server.js            real motors (when you press Connect in the screen)
//   node src/server.js --mock     simulated motors
//   then open http://localhost:4000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import config from '../config/sculpture.config.js';
import { SculptureController } from './SculptureController.js';
import * as geometry from '../../shared/tetraGeometry.js';

const geometryRopeName = (ropeIndex) => `${geometry.ROPES[ropeIndex].name}${geometry.ROPES[ropeIndex].isDirect ? ' (tension)' : ''}`;

const { values: options } = parseArgs({ options: { mock: { type: 'boolean', default: false }, port: { type: 'string' }, http: { type: 'string' }, motors: { type: 'string' } } });
if (options.port) config.serial.path = options.port;
// --motors 2,6  -> drive only these motor IDs (e.g. a dry run with one connected motor)
if (options.motors) {
  const motorIds = options.motors.split(',').map(Number);
  config.drives.forEach((drive) => (drive.enabled = motorIds.includes(drive.motorId)));
  const enabled = config.drives.filter((drive) => drive.enabled).map((drive) => `ID ${drive.motorId} = rope ${geometryRopeName(drive.ropeIndex)}`);
  console.log(`Only driving: ${enabled.join(', ') || 'NONE (no motor has those IDs)'}`);
}
const httpPort = Number(options.http ?? config.server.httpPort);
const STATE_BROADCAST_MS = 40; // 25 updates per second to the screen

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const staticRoots = { '/shared/': join(projectRoot, 'shared'), '/': join(projectRoot, 'frontend') };
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const controller = new SculptureController(config, { mock: options.mock });
controller.startSimulation();

// ---- static files ---------------------------------------------------------------------------
const httpServer = http.createServer(async (request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const [prefix, root] = Object.entries(staticRoots).find(([prefix]) => urlPath.startsWith(prefix));
  const relativePath = urlPath.slice(prefix.length) || 'index.html';
  const filePath = normalize(join(root, relativePath));
  if (!filePath.startsWith(root + sep) && filePath !== root) return response.writeHead(403).end();
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

// ---- websocket ------------------------------------------------------------------------------
const webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });
const send = (socket, message) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(message));
const broadcast = (message) => webSocketServer.clients.forEach((socket) => send(socket, message));

// Commands the screen may send: { type, ...arguments }
const commands = {
  setInputs: ({ inputs }) => controller.setInputs(inputs),
  setSimulationRunning: ({ running }) => controller.setSimulationRunning(running),
  connectMotors: () => controller.connectMotors(),
  disconnectMotors: () => controller.disconnectMotors(),
  home: ({ confirmDrumsEmpty }) => controller.home({ confirmDrumsEmpty }),
  startMotors: () => controller.startStreaming(),
  stopMotors: () => controller.stopStreaming(),
  emergencyStop: () => controller.emergencyStop(),
};

webSocketServer.on('connection', (socket) => {
  send(socket, {
    type: 'hello',
    mock: options.mock,
    geometry: { nodeRestPositions: geometry.NODE_REST_POSITIONS, boxCorners: geometry.BOX_CORNERS, tetraEdges: geometry.TETRA_EDGES, cornerRopeLines: geometry.CORNER_ROPE_LINES, boxEdges: geometry.BOX_EDGES },
    motion: config.motion,
  });
  socket.on('message', async (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return send(socket, { type: 'error', message: 'Invalid JSON' });
    }
    const command = commands[message.type];
    if (!command) return send(socket, { type: 'error', message: `Unknown command ${message.type}` });
    try {
      await command(message);
    } catch (error) {
      send(socket, { type: 'error', message: `${message.type}: ${error.message}` });
    }
  });
});

controller.on('log', (text) => {
  console.log(text);
  broadcast({ type: 'log', text });
});
controller.on('error', (error) => {
  console.error(error.message);
  broadcast({ type: 'error', message: error.message });
});
setInterval(() => broadcast({ type: 'state', ...controller.snapshot() }), STATE_BROADCAST_MS);

httpServer.listen(httpPort, () => console.log(`Tetra running: http://localhost:${httpPort}${options.mock ? '  (simulated motors)' : ''}`));

process.on('SIGINT', async () => {
  console.log('\nShutting down: stopping motors...');
  try {
    await controller.disconnectMotors();
  } finally {
    process.exit(0);
  }
});
