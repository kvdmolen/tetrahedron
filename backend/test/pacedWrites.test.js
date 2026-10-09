// Paced writes against simulated drives with a USB-converter-like 16 ms reply delay.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ModbusRtuBus } from '../src/ModbusRtuBus.js';
import { MockPort } from '../src/MockPort.js';
import { IclRsMotor } from '../src/IclRsMotor.js';
import { MotorGroup } from '../src/MotorGroup.js';

const motorIds = Array.from({ length: 12 }, (_, i) => i + 1);
const bus = new ModbusRtuBus({ port: new MockPort({ ids: motorIds, latencyMs: 16 }), baudRate: 115200 });
await bus.open();
const motors = motorIds.map((id) => new IclRsMotor(bus, id));

const timeMoves = async (paced) => {
  const start = performance.now();
  for (const motor of motors) await motor.moveToPulses(1000, { rpm: 60, paced });
  return performance.now() - start;
};
const waitingMs = await timeMoves(false);
const pacedMs = await timeMoves(true);
console.log(`12 moves: waiting for replies ${waitingMs.toFixed(0)} ms, paced ${pacedMs.toFixed(0)} ms`);
assert.ok(pacedMs < waitingMs / 2, 'paced writes are much faster with a slow converter');

// a normal read after paced writes waits for (and checks) all their replies first
assert.equal((await motors[0].readReg(0x0001)), 10000);
assert.equal(bus.stats.pacedReplies, 12);
assert.equal(bus.stats.pacedMissing, 0);

// a drive that doesn't answer (unit 20 doesn't exist) is detected, and later replies still match
const problems = [];
bus.on('pacedError', ({ unit }) => problems.push(unit));
await bus.writeSingle(3, 0x0191, 10, { paced: true });
await bus.writeSingle(20, 0x0191, 10, { paced: true });
await bus.writeSingle(4, 0x0191, 10, { paced: true });
await motors[0].readReg(0x0001);
assert.deepEqual(problems, [20]);
assert.equal(bus.stats.pacedReplies, 14);
assert.equal(bus.stats.pacedMissing, 1);

// streaming 12 motors at 10 Hz fits only with paced writes
const runGroup = async (pacedWrites) => {
  const group = new MotorGroup(bus, motors, { rateHz: 8, pacedWrites, statusEvery: 3 });
  let overruns = 0;
  group.on('overrun', () => overruns++);
  await group.start((t, i) => 0.5 * Math.sin(t + i), { seconds: 2 });
  return overruns;
};
const overrunsWaiting = await runGroup(false);
const overrunsPaced = await runGroup(true);
console.log(`12 motors at 8 Hz for 2 s: late ticks waiting ${overrunsWaiting}, paced ${overrunsPaced}`);
assert.ok(overrunsWaiting > 5, 'waiting for replies cannot keep up');
assert.equal(overrunsPaced, 0);
await bus.close();
console.log('paced writes ok', bus.stats);
