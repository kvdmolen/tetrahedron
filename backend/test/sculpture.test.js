// End-to-end against simulated drives: connect, home, stream while the shape changes,
// and check every motor ends up where the model says (after the motor delay).
import assert from 'node:assert/strict';
import config from '../config/sculpture.config.js';
import { SculptureController } from '../src/SculptureController.js';
import { TrajectoryBuffer } from '../src/TrajectoryBuffer.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TrajectoryBuffer interpolation
const buffer = new TrajectoryBuffer();
buffer.push(0, [0, 10]);
buffer.push(100, [1, 20]);
assert.equal(buffer.valueAt(50, 0), 0.5);
assert.equal(buffer.valueAt(-5, 1), 10);
assert.equal(buffer.valueAt(500, 1), 20);

const testConfig = structuredClone(config);
Object.assign(testConfig.motion, { homingRpm: 300, syncRpm: 300, motorDelayMs: 700, updateRateHz: 5 });
const controller = new SculptureController(testConfig, { mock: true });
controller.on('error', (error) => console.error('controller error:', error.message));
controller.startSimulation();

await assert.rejects(() => controller.home({ confirmDrumsEmpty: true }), /disconnected/);
await controller.connectMotors();
await assert.rejects(() => controller.startStreaming(), /Home/);
await assert.rejects(() => controller.home(), /confirmation/);
await controller.home({ confirmDrumsEmpty: true });
assert.equal(controller.homed, true);

const restTargets = controller.currentRopeTargets();
const pullAhead = testConfig.tension.pullAheadTurns;
const expectedTurns = (drive, targets) => targets[drive.rope.index].revolutions + (drive.isTension ? pullAhead : 0);
for (const drive of controller.enabledDrives) {
  const { feedback } = await drive.motor.positions();
  assert.ok(Math.abs(feedback / drive.motor.pulsesPerRev - expectedTurns(drive, restTargets)) < 0.01, `${drive.name} homed`);
}
const tensionDrives = controller.enabledDrives.filter((drive) => drive.isTension);
assert.deepEqual(tensionDrives.map((drive) => drive.motorId), [1, 6, 11, 16]);
for (const drive of tensionDrives) {
  const amps = await drive.motor.peakCurrent();
  assert.equal(amps, drive.tensionCurrentA(restTargets[drive.rope.index].woundLengthMm, testConfig.tension), `${drive.name} tension current`);
}
console.log(`tension ropes ${tensionDrives.map((drive) => drive.name).join(' ')}: ${(await tensionDrives[0].motor.peakCurrent())} A at rest (drum radius ${tensionDrives[0].drumRadiusMm(restTargets[0].woundLengthMm).toFixed(0)} mm)`);
console.log(`homed 16 motors; rest pose = ${restTargets.map((t) => t.revolutions.toFixed(2)).join(' ')} turns`);

await controller.startStreaming();
assert.equal(controller.motorState, 'streaming');
controller.setInputs({ position: { x: 0.3 }, size: 0.2, skew: { e01: 0.3 } });
await sleep(3000); // model settles (~2 s), motors follow 0.7 s later
await controller.stopStreaming();
await sleep(1500); // last moves finish
assert.equal(controller.motorState, 'idle');

const finalTargets = controller.currentRopeTargets();
let worstError = 0;
for (const drive of controller.enabledDrives) {
  const { feedback } = await drive.motor.positions();
  worstError = Math.max(worstError, Math.abs(feedback / drive.motor.pulsesPerRev - expectedTurns(drive, finalTargets)));
}
console.log(`streamed: worst motor error vs model ${worstError.toFixed(3)} turns, late ticks ${controller.overrunCount}`);
assert.ok(worstError < 0.05, 'motors follow the model');
assert.ok(finalTargets.some((target, index) => Math.abs(target.revolutions - restTargets[index].revolutions) > 0.2), 'shape actually changed');

// emergency stop must abort a running homing
const homing = controller.home({ confirmDrumsEmpty: true });
await sleep(100);
await controller.emergencyStop();
await assert.rejects(homing, /emergency stop/);
assert.equal(controller.motorState, 'idle');
await controller.disconnectMotors();
controller.stopSimulation();
console.log('sculpture ok');
