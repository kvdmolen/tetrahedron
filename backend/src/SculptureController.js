import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { RopeModel } from '../../shared/RopeModel.js';
import { ROPES, MM_PER_MODEL_UNIT } from '../../shared/tetraGeometry.js';
import { defaultShapeInputs, mergeShapeInputs, computeNodeTargets } from '../../shared/shapeControls.js';
import { ModbusRtuBus } from './ModbusRtuBus.js';
import { IclRsMotor } from './IclRsMotor.js';
import { MotorGroup } from './MotorGroup.js';
import { MockPort } from './MockPort.js';
import { REG, PR_CMD } from './registers.js';
import { RopeDrive } from './RopeDrive.js';
import { TrajectoryBuffer } from './TrajectoryBuffer.js';
import { findRs485Port } from './serialPorts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the rope model in real time and (optionally) drives the motors from it.
 *
 *   inputs (from the screen) -> node targets -> RopeModel (100 Hz) -> 16 free rope lengths
 *     -> RopeDrive: motor turns -> TrajectoryBuffer -> MotorGroup plays it `motorDelayMs` later
 *
 * Motor states: disconnected -> idle <-> homing | syncing -> streaming
 * Events: 'log' (text), 'error' (Error)
 */
export class SculptureController extends EventEmitter {
  constructor(config, { mock = false } = {}) {
    super();
    this.config = structuredClone(config);
    this.mock = mock;
    if (mock) {
      // simulated motors: no need to wait minutes for homing
      this.config.motion.homingRpm *= 10;
      this.config.motion.syncRpm *= 10;
    }
    config = this.config;
    this.inputs = defaultShapeInputs();
    this.model = new RopeModel({ pullStrength: config.simulation.pullStrength });
    this.drives = config.drives.map((driveConfig) => new RopeDrive({ ...driveConfig, rope: ROPES[driveConfig.ropeIndex] }, config.pulley));
    this.motorTargets = new TrajectoryBuffer({ maxAgeMs: config.motion.motorDelayMs + 5000 });

    this.simulationRunning = true; // the screen's Run/Stop
    this.modelFrozen = false; //      held still by homing / syncing
    this.motorState = 'disconnected';
    this.homed = false;
    this.activity = ''; //            human-readable progress (homing, syncing)
    this.lastError = null;
    this.overrunCount = 0;
    this.bus = null;
    this.motorGroup = null;
    this.streamingDone = null;
    this.abortRequested = false; // set by emergencyStop, ends homing / syncing
    this.tensionCurrentTimer = null;
  }

  get enabledDrives() {
    return this.drives.filter((drive) => drive.enabled);
  }

  // ---- simulation ------------------------------------------------------------------------

  startSimulation() {
    const stepMs = RopeModel.STEP_MS;
    let simulationClockMs = performance.now();
    this._recordMotorTargets(simulationClockMs);
    this.simulationTimer = setInterval(() => {
      const now = performance.now();
      if (now - simulationClockMs > 500) simulationClockMs = now - stepMs; // we were stalled: don't fast-forward
      while (simulationClockMs + stepMs <= now) {
        simulationClockMs += stepMs;
        if (this.simulationRunning && !this.modelFrozen) {
          this.model.setNodeTargets(computeNodeTargets(this.inputs));
          this.model.step();
        }
        this._recordMotorTargets(simulationClockMs);
      }
    }, 4);
  }

  stopSimulation() {
    clearInterval(this.simulationTimer);
  }

  setInputs(update) {
    this.inputs = mergeShapeInputs(this.inputs, update);
  }

  setSimulationRunning(running) {
    this.simulationRunning = !!running;
  }

  /** Free length and motor target of every rope, for the model's current state. */
  currentRopeTargets() {
    return this.model.ropeLengths().map((lengthInModelUnits, ropeIndex) => {
      const freeLengthMm = lengthInModelUnits * MM_PER_MODEL_UNIT;
      return { freeLengthMm, ...this.drives[ropeIndex].motorTargetForFreeLength(freeLengthMm) };
    });
  }

  /** Motor target in turns: the model's, plus (for tension ropes) the pull-ahead that keeps them stalled. */
  _motorTargetTurns(drive, modelTurns) {
    return drive.isTension ? modelTurns + drive.windDirection * this.config.tension.pullAheadTurns : modelTurns;
  }

  /** Set each tension motor's peak current for its current drum radius (only sent when it changed). */
  async _applyTensionCurrents({ force = false } = {}) {
    for (const drive of this.enabledDrives.filter((enabledDrive) => enabledDrive.isTension)) {
      const amps = drive.tensionCurrentA(this.latestRopeTargets[drive.rope.index].woundLengthMm, this.config.tension);
      if (!force && drive.tensionCurrentAppliedA !== undefined && Math.abs(amps - drive.tensionCurrentAppliedA) < 0.1) continue;
      await drive.motor.setPeakCurrent(amps);
      drive.tensionCurrentAppliedA = amps;
    }
  }

  _recordMotorTargets(timeMs) {
    this.latestRopeTargets = this.currentRopeTargets();
    this.motorTargets.push(timeMs, this.latestRopeTargets.map((target) => target.revolutions));
  }

  // ---- motors ----------------------------------------------------------------------------

  async connectMotors() {
    this._requireMotorState('disconnected');
    this.motorState = 'connecting';
    try {
      const motorIds = this.enabledDrives.map((drive) => drive.motorId);
      if (this.mock) {
        this.bus = new ModbusRtuBus({ port: new MockPort({ ids: motorIds }), baudRate: this.config.serial.baudRate });
      } else {
        const path = await findRs485Port(this.config.serial.path);
        this.bus = new ModbusRtuBus({ path, baudRate: this.config.serial.baudRate });
        this._log(`Opening ${path} @ ${this.config.serial.baudRate}`);
      }
      await this.bus.open();
      const missing = [];
      for (const drive of this.enabledDrives) {
        const motor = new IclRsMotor(this.bus, drive.motorId, { name: drive.name });
        try {
          await motor.syncPulsesPerRev();
          drive.motor = motor;
        } catch (error) {
          missing.push(`${drive.name} (ID ${drive.motorId}): ${error.message}`);
        }
      }
      if (missing.length) throw new Error(`Motors not answering:\n${missing.join('\n')}`);
      this.motorState = 'idle';
      this._log(`Connected ${this.enabledDrives.length} motor(s)${this.mock ? ' (simulated)' : ''}`);
    } catch (error) {
      await this.bus?.close().catch(() => {});
      this.bus = null;
      this.motorState = 'disconnected';
      throw error;
    }
  }

  async disconnectMotors() {
    if (this.motorState === 'streaming') await this.stopStreaming();
    await this.bus?.close();
    this.bus = null;
    this.drives.forEach((drive) => (drive.motor = null));
    this.motorState = 'disconnected';
    this.homed = false;
  }

  /**
   * Homing. Before this, ALL rope must be off ALL drums (fully extended): that is position 0.
   * Then, one motor at a time, each winds its rope up to the rest pose (all inputs 0).
   * Position ropes go first, the 4 tension ropes last.
   */
  async home({ confirmDrumsEmpty = false } = {}) {
    this._requireMotorState('idle');
    if (!confirmDrumsEmpty) throw new Error('Homing needs confirmation that all rope is off all drums.');
    this.motorState = 'homing';
    this.modelFrozen = true;
    this.abortRequested = false;
    try {
      this.inputs = defaultShapeInputs();
      this.model.reset();
      this.model.setNodeTargets(computeNodeTargets(this.inputs));
      const restTargets = this.currentRopeTargets();
      this.latestRopeTargets = restTargets;
      const homingOrder = [...this.enabledDrives].sort((a, b) => Number(a.isTension) - Number(b.isTension));
      for (const motor of homingOrder.map((drive) => drive.motor)) await motor.setZero();
      await this._applyTensionCurrents({ force: true }); // tension ropes never pull harder than their set force
      for (const [count, drive] of homingOrder.entries()) {
        const targetTurns = this._motorTargetTurns(drive, restTargets[drive.rope.index].revolutions);
        this.activity = `Homing ${count + 1}/${homingOrder.length}: ${drive.name}${drive.isTension ? ' (tension)' : ''} → ${targetTurns.toFixed(2)} turns`;
        this._log(this.activity);
        await drive.motor.moveToRev(targetTurns, { rpm: this.config.motion.homingRpm });
        await this._waitUntilArrived(drive.motor, targetTurns, this.config.motion.homingRpm, { commandedOnly: drive.isTension });
      }
      this.homed = true;
      this._log('Homing done: sculpture at rest pose');
    } finally {
      this.activity = '';
      this.modelFrozen = false;
      if (this.motorState === 'homing') this.motorState = 'idle';
    }
  }

  /** Move all motors to the model's current pose, then follow the model continuously. */
  async startStreaming() {
    this._requireMotorState('idle');
    if (!this.homed) throw new Error('Home the motors first.');
    const motion = this.config.motion;
    this.motorState = 'syncing';
    this.modelFrozen = true;
    this.abortRequested = false;
    try {
      this.activity = 'Moving motors to the current pose';
      const poseTargets = this.currentRopeTargets();
      this.latestRopeTargets = poseTargets;
      await this._applyTensionCurrents({ force: true });
      const syncTurns = (drive) => this._motorTargetTurns(drive, poseTargets[drive.rope.index].revolutions);
      for (const drive of this.enabledDrives) await drive.motor.moveToRev(syncTurns(drive), { rpm: motion.syncRpm });
      for (const drive of this.enabledDrives) await this._waitUntilArrived(drive.motor, syncTurns(drive), motion.syncRpm, { commandedOnly: drive.isTension });
      // stay frozen one delay longer, so the delayed trajectory starts exactly at this pose
      await sleep(motion.motorDelayMs);
      if (this.abortRequested) throw new Error('Aborted by emergency stop');
    } catch (error) {
      this.motorState = 'idle';
      throw error;
    } finally {
      this.activity = '';
      this.modelFrozen = false;
    }

    const drives = this.enabledDrives;
    this.motorGroup = new MotorGroup(this.bus, drives.map((drive) => drive.motor), {
      rateHz: motion.updateRateHz,
      lookahead: motion.lookaheadTicks,
      maxRpm: motion.maxRpm,
      ramp: motion.ramp,
      accMs: motion.fastestRampMs,
      decMs: motion.fastestRampMs,
    });
    this.motorGroup.on('overrun', () => this.overrunCount++);
    this.motorGroup.on('motorError', ({ motor, error }) => this._error(new Error(`${motor.name}: ${error.message}`)));
    this.motorGroup.on('alarm', ({ motor, text }) => this._error(new Error(`ALARM ${motor.name}: ${text} (streaming stopped)`)));
    this.motorGroup.on('fatal', ({ error }) => this._error(error));

    const streamStartMs = performance.now();
    const motorTimeMs = (secondsSinceStart) => streamStartMs + secondsSinceStart * 1000 - motion.motorDelayMs;
    this.motorState = 'streaming';
    this.overrunCount = 0;
    this._log(`Streaming ${drives.length} motor(s) at ${motion.updateRateHz} Hz, ${motion.motorDelayMs} ms behind the screen`);
    this.tensionCurrentTimer = setInterval(() => this._applyTensionCurrents().catch((error) => this._error(error)), this.config.tension.currentUpdateMs);
    const targetFor = (secondsSinceStart, motorIndex) => {
      const drive = drives[motorIndex];
      return this._motorTargetTurns(drive, this.motorTargets.valueAt(motorTimeMs(secondsSinceStart), drive.rope.index));
    };
    this.streamingDone = this.motorGroup
      .start(targetFor)
      .catch((error) => this._error(error))
      .finally(() => {
        clearInterval(this.tensionCurrentTimer);
        this.motorGroup = null;
        if (this.motorState === 'streaming') this.motorState = 'idle';
      });
  }

  /** Stop sending targets; motors finish their last (short) move. */
  async stopStreaming() {
    this.motorGroup?.stop();
    await this.streamingDone;
  }

  /** Quick-stop every drive at once (broadcast), works in any state. */
  async emergencyStop() {
    this.abortRequested = true;
    this.motorGroup?.stop();
    if (this.bus) await this.bus.broadcastWrite(REG.PR_CONTROL, PR_CMD.QUICK_STOP);
    this._log('EMERGENCY STOP sent');
  }

  /**
   * Wait until the shaft is at the target, or (commandedOnly, for tension motors that stall against
   * their rope) until the drive's commanded position is.
   */
  async _waitUntilArrived(motor, targetRevolutions, rpm, { commandedOnly = false } = {}) {
    const targetPulses = Math.round(targetRevolutions * motor.pulsesPerRev);
    const toleranceRevolutions = 0.01;
    const expectedMs = (Math.abs(targetRevolutions) / rpm) * 60000;
    const deadline = performance.now() + expectedMs * 1.5 + 5000;
    while (performance.now() < deadline) {
      if (this.abortRequested) throw new Error('Aborted by emergency stop');
      const { feedback, profile } = await motor.positions();
      if (Math.abs((commandedOnly ? profile : feedback) - targetPulses) <= toleranceRevolutions * motor.pulsesPerRev) return;
      await sleep(150);
    }
    throw new Error(`${motor.name} did not reach ${targetRevolutions.toFixed(2)} turns in time`);
  }

  _requireMotorState(expected) {
    if (this.motorState !== expected) throw new Error(`Motors are ${this.motorState}; this needs them ${expected}.`);
  }

  _log(text) {
    this.emit('log', text);
  }

  _error(error) {
    this.lastError = { message: error.message, timeMs: Date.now() };
    this.emit('error', error);
  }

  // ---- state for the screen --------------------------------------------------------------

  snapshot() {
    return {
      nodes: this.model.nodePositions(),
      inputs: this.inputs,
      simulationRunning: this.simulationRunning,
      motorState: this.motorState,
      homed: this.homed,
      activity: this.activity,
      lastError: this.lastError,
      overrunCount: this.overrunCount,
      busStats: this.bus?.stats ?? null,
      ropes: this.latestRopeTargets.map((target, ropeIndex) => ({
        name: this.drives[ropeIndex].name,
        motorId: this.drives[ropeIndex].motorId,
        enabled: this.drives[ropeIndex].enabled,
        isTension: this.drives[ropeIndex].isTension,
        tensionCurrentA: this.drives[ropeIndex].tensionCurrentAppliedA ?? null,
        freeLengthMm: Math.round(target.freeLengthMm),
        woundLengthMm: Math.round(target.woundLengthMm),
        revolutions: Number(target.revolutions.toFixed(3)),
        limited: target.limited,
      })),
    };
  }
}
