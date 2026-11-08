// End-to-end against simulated drives: connect, home, stream while the shape changes,
// and check every motor ends up where the model says (after the motor delay).
import assert from 'node:assert/strict';
import config from '../config/sculpture.config.js';
import { SculptureController } from '../src/SculptureController.js';
import { TrajectoryBuffer } from '../src/TrajectoryBuffer.js';
import { REG } from '../src/registers.js';

import { performance } from 'node:perf_hooks';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TrajectoryBuffer interpolation
const buffer = new TrajectoryBuffer();
buffer.push(0, [0, 10]);
buffer.push(100, [1, 20]);
assert.equal(buffer.valueAt(50, 0), 0.5);
assert.equal(buffer.valueAt(-5, 1), 10);
assert.equal(buffer.valueAt(500, 1), 20);

const testConfig = structuredClone(config);
Object.assign(testConfig.motion, { motorDelayMs: 700, updateRateHz: 5 });
Object.assign(testConfig.transition, { minSeconds: 2, ropeSpeedMmPerS: 300 });
Object.assign(testConfig.homing, { rpm: 30, softRpm: 30, stepByStep: true }); // x10 in mock mode
testConfig.drives.forEach((drive) => (drive.enabled = true)); // all 16, suspension motors too
const controller = new SculptureController(testConfig, { mock: true });
controller.on('error', (error) => console.error('controller error:', error.message));
controller.startSimulation();

await assert.rejects(() => controller.home(), /disconnected/);
await controller.connectMotors();
await assert.rejects(() => controller.startStreaming(), /Home/);
// step by step, like a person at the screen: rope 1 jogged (-5 then +10 mm: the end is 5 mm further out),
// rope 2 "continue winding" once, rope 3 stopped while winding and resumed; every rope confirmed
const homingStarted = performance.now();
let homingFinished = false;
const homingDone = controller.home();
homingDone.finally(() => (homingFinished = true)).catch(() => {});
const tried = new Set();
let confirms = 0;
while (!homingFinished) {
  const step = controller.homingStep;
  if (step?.phase === 'searching' && step.number === 3 && !tried.has('pause')) {
    controller.homingAction('pause');
    tried.add('pause');
  } else if (step?.phase === 'paused') {
    await sleep(300);
    controller.homingAction('resume');
  } else if (step?.phase === 'confirm') {
    if (step.number === 1 && !tried.has('jog')) {
      controller.homingAction('jog', -5);
      await sleep(300);
      controller.homingAction('jog', 10);
      await sleep(300);
      assert.equal(controller.homingStep.adjustMm, 5);
      tried.add('jog');
    } else if (step.number === 2 && !tried.has('retry')) {
      controller.homingAction('retry');
      tried.add('retry');
    } else {
      controller.homingAction('confirm');
      assert.throws(() => controller.homingAction('confirm'), /can't confirm/); // a double click doesn't skip a rope
      confirms++;
    }
  }
  await sleep(10);
}
await homingDone;
assert.equal(controller.homed, true);
const positionDrives = controller.enabledDrives.filter((drive) => !drive.isTension);
assert.equal(confirms, positionDrives.length);
assert.deepEqual([...tried].sort(), ['jog', 'pause', 'retry']);
assert.throws(() => controller.homingAction('confirm'), /not running/);
// every position rope found its end: its position now matches where the simulated rope really started
const endFreeLength = testConfig.homing.endFreeLengthMm;
for (const [index, drive] of positionDrives.entries()) {
  const foundStartTurns = drive.motor.offsetPulses / drive.motor.pulsesPerRev;
  // rope 1: the confirmed spot was 5 mm further out than the real end, and counts as the end
  const shift = index === 0 ? drive.revolutionsForFreeLength(endFreeLength) - drive.revolutionsForFreeLength(endFreeLength + 5) : 0;
  assert.ok(Math.abs(foundStartTurns - controller.mockStartTurns[drive.motorId] - shift) < 0.001, `${drive.name}: start ${foundStartTurns} vs ${controller.mockStartTurns[drive.motorId] + shift}`);
}
console.log(`homed ${positionDrives.length} position ropes by winding each to its end in ${((performance.now() - homingStarted) / 1000).toFixed(1)} s`);

// after homing the motors hold where they are; the transition takes them to the simulation's pose
// (positions of all simulated shafts at one instant: reading them over the bus takes long enough for them to move)
const shaftTurnsNow = (drive) => {
  const slave = controller.mockPort.slaves.get(drive.motorId);
  controller.mockPort._advance(slave);
  const shaft = Math.min(slave.stop.max ?? Infinity, Math.max(slave.stop.min ?? -Infinity, slave.pos));
  return (shaft + drive.motor.offsetPulses - drive.motor.zeroPulses) / drive.motor.pulsesPerRev;
};
const pullAhead = testConfig.tension.pullAheadTurns;
const expectedTurns = (drive, targets) => targets[drive.rope.index].revolutions + (drive.isTension ? drive.windDirection * pullAhead : 0);
const transitionLog = [];
controller.on('log', (text) => text.startsWith('Transition') && transitionLog.push(text));
controller.setInputs({ size: -0.4, AB: 0.5 }); // not the rest pose
await sleep(1500); // the model gets there
const fromMm = new Map();
for (const drive of positionDrives) fromMm.set(drive, drive.freeLengthForRevolutions((await drive.motor.positions()).feedback / drive.motor.pulsesPerRev));
const poseTargets = controller.currentRopeTargets();
const transitionStarted = performance.now();
await controller.startStreaming();
assert.equal(controller.motorState, 'syncing');
assert.equal(controller.snapshot().synced, false);
const transitionSeconds = Number(/, ([\d.]+) s$/.exec(transitionLog.at(-1))[1]);
// halfway: every position rope has gone the same fraction of its way, plus the same slack
await sleep(transitionSeconds * 500 - (performance.now() - transitionStarted));
const halfway = [];
for (const drive of positionDrives) {
  const nowMm = drive.freeLengthForRevolutions(shaftTurnsNow(drive));
  halfway.push({ way: poseTargets[drive.rope.index].freeLengthMm - fromMm.get(drive), gone: nowMm - fromMm.get(drive) });
}
// fit gone = fraction × way + slack over all ropes; every rope must be on that line
const n = halfway.length, sumWay = halfway.reduce((sum, h) => sum + h.way, 0), sumGone = halfway.reduce((sum, h) => sum + h.gone, 0);
const fraction = (n * halfway.reduce((sum, h) => sum + h.way * h.gone, 0) - sumWay * sumGone) / (n * halfway.reduce((sum, h) => sum + h.way * h.way, 0) - sumWay ** 2);
const slack = (sumGone - fraction * sumWay) / n;
const worstOffLine = Math.max(...halfway.map((h) => Math.abs(h.gone - fraction * h.way - slack)));
// between two commands each motor runs at a constant speed, so while the transition speeds up the motor sent
// first is a little ahead: ~6 mm here (3× the real rope speed), ~2 mm at the real 100 mm/s
assert.ok(fraction > 0.2 && fraction < 0.8 && worstOffLine < 10, `in step: fraction ${fraction.toFixed(2)}, slack ${slack.toFixed(1)} mm, worst ${worstOffLine.toFixed(1)} mm off`);
while (controller.motorState === 'syncing') await sleep(20);
assert.equal(controller.motorState, 'streaming');
assert.equal(controller.snapshot().synced, true);
const syncedAfter = (performance.now() - transitionStarted) / 1000;
await sleep(800); // tension motors: their pull-ahead from the moment they got their position
for (const drive of controller.enabledDrives) {
  const { feedback } = await drive.motor.positions();
  assert.ok(Math.abs(feedback / drive.motor.pulsesPerRev - expectedTurns(drive, poseTargets)) < 0.02, `${drive.name} at the simulation's pose: ${(feedback / drive.motor.pulsesPerRev).toFixed(3)} vs ${expectedTurns(drive, poseTargets).toFixed(3)}, now ${expectedTurns(drive, controller.currentRopeTargets()).toFixed(3)}`);
}
const tensionDrives = controller.enabledDrives.filter((drive) => drive.isTension);
assert.deepEqual(tensionDrives.map((drive) => drive.motorId), [1, 5, 9, 13]);
assert.ok(tensionDrives.every((drive) => drive.positionKnown), 'tension ropes take their position at the end of the transition');
for (const drive of tensionDrives) {
  const amps = await drive.motor.peakCurrent();
  assert.equal(amps, drive.tensionCurrentA(poseTargets[drive.rope.index].woundLengthMm, testConfig.tension), `${drive.name} tension current`);
}
assert.equal(await positionDrives[0].motor.peakCurrent(), 4, 'position motors back at their normal current');
console.log(`transition: all ropes in step halfway (${(fraction * 100).toFixed(0)} %, slack ${slack.toFixed(0)} mm, worst ${worstOffLine.toFixed(1)} mm off), synced after ${syncedAfter.toFixed(1)} s`);

// the 3D view shows the pose the motors are at: motorDelayMs behind the model
controller.setInputs({ A: 0.6, BC: 0.5, size: 0.3 });
await sleep(300);
const shown = controller.snapshot().nodes, live = controller.model.nodePositions();
assert.ok(shown.some((position, node) => position.some((coordinate, axis) => Math.abs(coordinate - live[node][axis]) > 1e-3)), 'view is behind the model');
await sleep(2700); // model settles (~1 s), motors follow 0.7 s later
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
assert.ok(finalTargets.some((target, index) => Math.abs(target.revolutions - poseTargets[index].revolutions) > 0.2), 'shape actually changed');

// stopped: the simulation runs on its own; Start goes through the transition again
controller.setInputs({ size: 0.6 });
await sleep(1000);
await controller.startStreaming();
while (controller.motorState === 'syncing') await sleep(20);
assert.equal(controller.motorState, 'streaming');
const restartTargets = controller.currentRopeTargets();
for (const drive of positionDrives) assert.ok(Math.abs((await drive.motor.positions()).feedback / drive.motor.pulsesPerRev - restartTargets[drive.rope.index].revolutions) < 0.02, `${drive.name} synced again`);
console.log('stop, simulation on its own, start: synced again through the transition');
// already there: the transition is only the slack, the same on every rope (most halfway)
await controller.stopStreaming();
await sleep(500);
const atPose = controller.currentRopeTargets();
const slackStarted = performance.now();
await controller.startStreaming();
const slackSeconds = Number(/, ([\d.]+) s$/.exec(transitionLog.at(-1))[1]);
await sleep(slackSeconds * 500 - (performance.now() - slackStarted));
const extraMm = [];
for (const drive of positionDrives) extraMm.push(drive.freeLengthForRevolutions(shaftTurnsNow(drive)) - atPose[drive.rope.index].freeLengthMm);
assert.ok(Math.min(...extraMm) > 0.5 * testConfig.transition.slackMm && Math.max(...extraMm) - Math.min(...extraMm) < 3, `slack halfway: ${extraMm.map((mm) => mm.toFixed(1)).join(' ')}`);
while (controller.motorState === 'syncing') await sleep(20);
console.log(`slack: ${Math.min(...extraMm).toFixed(1)}-${Math.max(...extraMm).toFixed(1)} mm extra on every rope halfway (${testConfig.transition.slackMm} mm at the middle)`);

// homing is kept: an emergency stop, a re-homing stopped halfway, disconnect + connect
await controller.emergencyStop();
assert.equal(controller.homed, true, 'an emergency stop keeps the homing');
const homedOffsets = controller.enabledDrives.map((drive) => drive.motor.offsetPulses);
const homing = controller.home();
await sleep(100);
await controller.emergencyStop();
await assert.rejects(homing, /emergency stop/);
assert.equal(controller.motorState, 'idle');
assert.equal(controller.homed, true, 'a stopped re-homing keeps the previous homing');
assert.deepEqual(controller.enabledDrives.map((drive) => drive.motor.offsetPulses), homedOffsets);
await controller.disconnectMotors();
await controller.connectMotors();
assert.equal(controller.homed, true, 'still homed after disconnect + connect');
assert.deepEqual(controller.enabledDrives.map((drive) => drive.motor.offsetPulses), homedOffsets);
// a drive that lost power (its RAM marker is back to the saved value) loses the homing
controller.bus.port.slaves.get(7).regs.set(REG.SESSION_MARKER, 0);
await assert.rejects(() => controller.startStreaming(), /Motor 7 restarted/);
assert.equal(controller.homed, false);
await controller.disconnectMotors();
controller.stopSimulation();
console.log('homing kept over emergency stop, stopped re-homing and reconnect; lost when a drive restarts');
// a rope that never reaches an end (not attached) stops homing with an error, after all its rope
{
  const config = structuredClone(testConfig);
  config.homing.stepByStep = false;
  config.drives.forEach((drive) => (drive.enabled = [2, 3].includes(drive.motorId)));
  const detached = new SculptureController(config, { mock: true });
  const makeEndStops = detached._mockEndStops.bind(detached);
  detached._mockEndStops = () => ({ ...makeEndStops(), 2: {} }); // motor 2: nothing stops it
  await detached.connectMotors();
  await assert.rejects(() => detached.home(), /A:AB: wound .* turns without reaching the end/);
  assert.equal(detached.homed, false);
  assert.equal(detached.motorState, 'idle');
  await detached.disconnectMotors();
  console.log('rope without an end: homing stops with an error');
}
// soft pulling stops at a found rope's end, even when nothing holds it there (rope taken off: testing)
{
  const config = structuredClone(testConfig);
  config.homing.stepByStep = false;
  config.drives.forEach((drive) => (drive.enabled = [2, 3].includes(drive.motorId)));
  const loose = new SculptureController(config, { mock: true });
  const makeEndStops = loose._mockEndStops.bind(loose);
  loose._mockEndStops = () => ({ ...makeEndStops(), 3: {} }); // motor 3: no end, so homing fails on it
  loose.on('log', (text) => {
    if (text.startsWith('A:AB: end reached')) loose.bus.port.slaves.get(2).stop = {}; // and now nothing holds rope 1
  });
  await loose.connectMotors();
  await assert.rejects(() => loose.home(), /A:AC: wound/);
  const ropeOne = loose.enabledDrives[0];
  const turns = (await ropeOne.motor.positions()).feedback / ropeOne.motor.pulsesPerRev;
  const endTurns = ropeOne.revolutionsForFreeLength(config.homing.endFreeLengthMm);
  assert.ok(Math.abs(turns - endTurns) < 0.05, `found rope stays at its end while pulled softly: ${turns.toFixed(2)} vs ${endTurns.toFixed(2)} turns`);
  await loose.disconnectMotors();
  console.log('soft pulling stops at a found rope\'s end');
}
// homing override (testing without ropes): homed where the motors are, at the simulation's pose
{
  const config = structuredClone(testConfig);
  config.drives.forEach((drive) => (drive.enabled = [2, 3, 5].includes(drive.motorId)));
  const tester = new SculptureController(config, { mock: true });
  const logs = [];
  tester.on('log', (text) => logs.push(text));
  await tester.connectMotors();
  await tester.homeHere();
  assert.equal(tester.homed, true);
  const targets = tester.currentRopeTargets();
  for (const drive of tester.enabledDrives) assert.ok(Math.abs((await drive.motor.positions()).feedback / drive.motor.pulsesPerRev - targets[drive.rope.index].revolutions) < 0.001, `${drive.name} homed here`);
  await tester.startStreaming();
  assert.match(logs.find((text) => text.startsWith('Transition')), /: 0 mm at most/);
  await tester.emergencyStop();
  await tester.disconnectMotors();
  console.log('homing override: homed at the simulation\'s pose, nothing to move');
}
console.log('sculpture ok');
