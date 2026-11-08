import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { TetraModel, ROPES, MM_PER_MODEL_UNIT, STEP_MS, defaultInputValues, mergeInputValues } from '../../shared/tetra.js';
import { ease } from '../../shared/timeline.js';
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
 *   inputs (from the screen) -> segment stiffnesses -> TetraModel (100 Hz) -> 16 free rope lengths
 *     -> RopeDrive: motor turns -> TrajectoryBuffer -> MotorGroup plays it `motorDelayMs` later
 *
 * Motor states: disconnected -> idle <-> homing | syncing (the transition) -> streaming (synced)
 * Events: 'log' (text), 'error' (Error)
 */
export class SculptureController extends EventEmitter {
  constructor(config, { mock = false } = {}) {
    super();
    this.config = structuredClone(config);
    this.mock = mock;
    if (mock) {
      // simulated motors: no need to wait minutes for homing
      this.config.homing.rpm *= 10;
      this.config.homing.softRpm *= 10;
    }
    config = this.config;
    this.inputs = defaultInputValues();
    this.model = new TetraModel(config.model);
    this.drives = config.drives.map(
      (driveConfig) => new RopeDrive({ ...driveConfig, rope: ROPES[driveConfig.ropeIndex], positiveRotation: config.motor.positiveRotation }, config.pulley),
    );
    this.motorTargets = new TrajectoryBuffer({ maxAgeMs: config.motion.motorDelayMs + 5000 });
    this.nodeHistory = new TrajectoryBuffer({ maxAgeMs: config.motion.motorDelayMs + 1000 }); // for the delayed view

    this.simulationRunning = true; // the screen's Run/Stop
    this.modelFrozen = false; //      held still during the transition
    this.motorState = 'disconnected';
    // Homing (every position rope's position known) is kept until a drive loses power (see
    // _checkMotorsNotRestarted), also across an emergency stop, a failed homing and disconnect/connect.
    // Tension ropes aren't homed: drive.positionKnown is set at the end of their first transition.
    this.homed = false;
    this.sessionMarker = 1 + Math.floor(Math.random() * 65534); // written to every drive, see REG.SESSION_MARKER
    this.motorFrames = new Map(); //  motorId -> { zeroPulses, offsetPulses }, kept over a disconnect
    this.activity = ''; //            human-readable progress (homing, syncing)
    this.lastError = null;
    this.overrunCount = 0;
    this.bus = null;
    this.motorGroup = null;
    this.streamingDone = null;
    this.abortRequested = false; // set by emergencyStop, ends homing / syncing
    this.tensionCurrentTimer = null;
    this.homingStep = null; //     homing progress for the screen: { rope, motorId, number, total, phase, adjustMm }
    this.homingRequest = null; //  the screen's latest homing action, see homingAction()
  }

  get enabledDrives() {
    return this.drives.filter((drive) => drive.enabled);
  }

  // ---- simulation ------------------------------------------------------------------------

  startSimulation() {
    const stepMs = STEP_MS;
    let simulationClockMs = performance.now();
    this._recordMotorTargets(simulationClockMs);
    this.simulationTimer = setInterval(() => {
      const now = performance.now();
      if (now - simulationClockMs > 500) simulationClockMs = now - stepMs; // we were stalled: don't fast-forward
      while (simulationClockMs + stepMs <= now) {
        simulationClockMs += stepMs;
        if (this.simulationRunning && !this.modelFrozen) this.model.step();
        this._recordMotorTargets(simulationClockMs);
      }
    }, 4);
  }

  stopSimulation() {
    clearInterval(this.simulationTimer);
  }

  setInputs(update) {
    this.inputs = mergeInputValues(this.inputs, update);
    this.model.setInputs(this.inputs);
  }

  setSimulationRunning(running) {
    this.simulationRunning = !!running;
  }

  /** Nodes back to their start positions (refused while motors follow the model: they would jump). */
  resetModel() {
    if (['homing', 'syncing', 'streaming'].includes(this.motorState)) throw new Error(`Not while motors are ${this.motorState}; stop the motors first.`);
    this.model.reset();
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
    this.nodeHistory.push(timeMs, this.model.nodePositions().flat());
  }

  /** What the 3D view shows: while the motors follow the model, the pose they are at (motorDelayMs ago). */
  _displayedNodes() {
    if (!['syncing', 'streaming'].includes(this.motorState)) return this.model.nodePositions();
    const timeMs = performance.now() - this.config.motion.motorDelayMs;
    return [0, 1, 2, 3].map((node) => [0, 1, 2].map((axis) => this.nodeHistory.valueAt(timeMs, node * 3 + axis)));
  }

  // ---- motors ----------------------------------------------------------------------------

  async connectMotors() {
    this._requireMotorState('disconnected');
    this.motorState = 'connecting';
    try {
      const motorIds = this.enabledDrives.map((drive) => drive.motorId);
      if (this.mock) {
        // the simulated drives keep running over a disconnect, like real ones
        this.mockPort ??= new MockPort({ ids: motorIds, endStops: this._mockEndStops() });
        this.bus = new ModbusRtuBus({ port: this.mockPort, baudRate: this.config.serial.baudRate });
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
      // drives that kept running since we last connected keep their positions (and so the homing)
      const restarted = [];
      for (const drive of this.enabledDrives) {
        const frame = this.motorFrames.get(drive.motorId);
        if (frame && (await drive.motor.readReg(REG.SESSION_MARKER)) === this.sessionMarker) {
          Object.assign(drive.motor, frame);
        } else {
          await drive.motor.setZero(); // our reference for as long as the drive has power
          await drive.motor.writeReg(REG.SESSION_MARKER, this.sessionMarker);
          restarted.push(drive);
        }
      }
      const wasHomed = this.homed;
      this._forgetLostPositions(restarted);
      this.motorState = 'idle';
      this._log(`Connected ${this.enabledDrives.length} motor(s)${this.mock ? ' (simulated)' : ''}${this.homed ? '; still homed' : wasHomed ? `; homing lost (restarted: ${restarted.map((drive) => drive.motorId).join(', ')})` : ''}`);
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
    for (const drive of this.drives) {
      if (drive.motor) this.motorFrames.set(drive.motorId, { zeroPulses: drive.motor.zeroPulses, offsetPulses: drive.motor.offsetPulses });
      drive.motor = null;
    }
    this.motorState = 'disconnected';
  }

  /** Drives that restarted (lost power) don't know where they are any more: homing (partly) lost. */
  _forgetLostPositions(restartedDrives) {
    if (restartedDrives.some((drive) => !drive.isTension)) this.homed = false;
    for (const drive of restartedDrives) drive.positionKnown = false;
  }

  /** Before trusting the positions: has a drive lost power since we connected? Then homing is lost. */
  async _checkMotorsNotRestarted() {
    const restarted = [];
    for (const drive of this.enabledDrives) if ((await drive.motor.readReg(REG.SESSION_MARKER)) !== this.sessionMarker) restarted.push(drive);
    if (!restarted.length) return;
    for (const drive of restarted) {
      await drive.motor.setZero();
      await drive.motor.writeReg(REG.SESSION_MARKER, this.sessionMarker);
    }
    this._forgetLostPositions(restarted);
    throw new Error(`Motor ${restarted.map((drive) => drive.motorId).join(', ')} restarted (power off?), so its position is lost: home again.`);
  }

  /**
   * Automatic homing; the ropes may be anywhere. The main (suspension) ropes aren't homed.
   * 1. Every motor goes soft: a low current, always winding a little further than it is, so every rope stays
   *    just taut, slack is wound in, and a rope gives way when something pulls it.
   * 2. One position rope at a time winds in slowly with forceFraction of its normal current, until it can't go
   *    further (the shaft lags its command): the rope's end is at its exit point, free length endFreeLengthMm.
   *    stepByStep: then it waits on the screen (homingAction): confirm, jog ±, or continue winding (after some
   *    slack, for a false stop). Confirmed: where the rope is now IS endFreeLengthMm; it goes soft, next rope.
   *    Stop (pause) at any moment: every motor gives way and doesn't pull (untangling); resume carries on.
   * 3. Every position motor holds where it is, at normal current; the tension ropes keep pulling softly (like
   *    weights). The motors don't touch the model: startStreaming's transition takes them to the simulation.
   * Soft pulling never winds a found rope past its end, nor any drum more than all its rope: with no rope on
   * (testing) a drum would otherwise keep turning.
   * Stopped halfway (emergency stop, error): the previous homing, if any, stays.
   */
  async home() {
    this._requireMotorState('idle');
    this.motorState = 'homing';
    await this._checkMotorsNotRestarted().catch(() => {}); // a restarted drive: homing is what's needed anyway
    this.abortRequested = false;
    this.homingRequest = null;
    const homing = this.config.homing;
    const drives = this.enabledDrives;
    const positionDrives = drives.filter((drive) => !drive.isTension);
    const tensionDrives = drives.filter((drive) => drive.isTension);
    const saved = new Map(); // drive -> its settings before homing, restored afterwards
    const previous = { homed: this.homed, offsets: new Map(positionDrives.map((drive) => [drive, drive.motor.offsetPulses])) };
    let completed = false;
    const softDrives = new Set();
    const softStart = new Map(); // drive -> where it was when it went soft (pulses)
    const ropesFound = new Set(); // position known: soft pulls stop at the end
    let softTurn = 0, statusTurn = 0;
    const turnsOf = (drive, pulses) => pulses / drive.motor.pulsesPerRev;
    const forceCurrent = (drive) => saved.get(drive).peakCurrentA * homing.forceFraction;
    const checkAbort = () => {
      if (this.abortRequested) throw new Error('Aborted by emergency stop');
    };
    const takeRequest = (actions) => {
      const request = this.homingRequest;
      if (!request || !actions.includes(request.action)) return null;
      this.homingRequest = null;
      return request;
    };
    const checkAlarm = async () => {
      const watched = drives[statusTurn++ % drives.length];
      if ((await watched.motor.status()).fault) throw new Error(`ALARM ${watched.name}: ${(await watched.motor.alarm()).text} (homing stopped)`);
    };

    const pullSoftly = async (drive) => {
      const { feedback } = await drive.motor.positions();
      const pulsesPerRev = drive.motor.pulsesPerRev, wind = drive.windDirection;
      if (!softStart.has(drive)) softStart.set(drive, feedback);
      // how far it may wind (as wind × position): a found rope to its end, any other drum all its rope + 1 turn
      const limit = ropesFound.has(drive)
        ? wind * drive.revolutionsForFreeLength(homing.endFreeLengthMm) * pulsesPerRev
        : wind * softStart.get(drive) + (Math.abs(drive.revolutionsForFreeLength(0)) + 1) * pulsesPerRev;
      const target = Math.min(wind * feedback + homing.softPullTurns * pulsesPerRev, Math.max(limit, wind * feedback));
      await drive.motor.moveToPulses(wind * target, { rpm: homing.softRpm });
    };
    /** Keep the soft motors pulling (a few per call, round-robin) and watch one motor's alarm flag. */
    const tendOthers = async (count = 3) => {
      checkAbort();
      const soft = [...softDrives];
      for (let i = 0; i < Math.min(count, soft.length); i++) await pullSoftly(soft[softTurn++ % soft.length]);
      await checkAlarm();
    };
    const goSoft = async (drive) => {
      softStart.delete(drive); // its wind limit counts from here
      await drive.motor.setPeakCurrent(drive.isTension ? this.config.tension.currentA : homing.softCurrentA);
      await pullSoftly(drive);
      softDrives.add(drive);
    };
    const holdHere = async (drive) => {
      const { feedback } = await drive.motor.positions();
      await drive.motor.moveToPulses(feedback, { rpm: homing.rpm });
      return feedback;
    };

    /** Stopped (untangling): position motors give way and don't pull back; tension ropes keep pulling softly. */
    const pause = async (activeDrive, resumeText) => {
      this.homingStep = { ...this.homingStep, phase: 'paused' };
      this.activity = `Homing stopped: ropes give way (untangle gently). ${resumeText}`;
      this._log(`Homing stopped at ${activeDrive.name}`);
      await activeDrive.motor.setPeakCurrent(homing.softCurrentA);
      while (!takeRequest(['resume'])) {
        checkAbort();
        for (const drive of positionDrives) await holdHere(drive); // the command follows the shaft: no pulling back
        for (const drive of tensionDrives) await pullSoftly(drive);
        await checkAlarm();
        await sleep(20);
      }
      this._log('Homing resumed');
      await activeDrive.motor.setPeakCurrent(forceCurrent(activeDrive));
    };

    /** Wind in until the rope can't go further; returns once it's at its end (shaft lagging its command). */
    const windToEnd = async (drive, label) => {
      const motor = drive.motor, pulsesPerRev = motor.pulsesPerRev;
      for (;;) {
        this.homingStep = { ...this.homingStep, phase: 'searching' };
        this.activity = `${label}: winding in until it stops`;
        softDrives.delete(drive);
        const startPulses = await holdHere(drive); // a soft motor already lags a little: start from the shaft
        await motor.setPeakCurrent(forceCurrent(drive));
        // never wind further than all the rope (+1 turn): if it gets there, the rope isn't attached
        const maxTurns = Math.abs(drive.revolutionsForFreeLength(homing.endFreeLengthMm)) + 1;
        const limitPulses = startPulses + drive.windDirection * maxTurns * pulsesPerRev;
        await motor.moveToPulses(limitPulses, { rpm: homing.rpm });
        for (;;) {
          await tendOthers();
          if (takeRequest(['pause'])) break;
          const { profile, feedback } = await motor.positions();
          if (turnsOf(drive, drive.windDirection * (profile - feedback)) >= homing.stallLagTurns) {
            const endPulses = await holdHere(drive); // stop pulling, keep the rope where it is
            this._log(`${drive.name}: end reached after ${turnsOf(drive, Math.abs(endPulses - startPulses)).toFixed(2)} turns`);
            return;
          }
          if (Math.abs(profile - limitPulses) < 0.01 * pulsesPerRev) throw new Error(`${drive.name}: wound ${maxTurns.toFixed(1)} turns without reaching the end. Is the rope attached?`);
        }
        await holdHere(drive);
        await pause(drive, 'Resume homing winds this rope in again.');
      }
    };

    /** One rope: find its end, then (stepByStep) confirm, jog or continue winding. Ends with its position known. */
    const homeRope = async (drive, label) => {
      const motor = drive.motor;
      const endTurns = drive.revolutionsForFreeLength(homing.endFreeLengthMm);
      for (;;) {
        await windToEnd(drive, label);
        await motor.definePosition(endTurns * motor.pulsesPerRev); // tentatively: here it's endFreeLengthMm
        if (!homing.stepByStep) return ropesFound.add(drive);
        let adjustMm = 0;
        const moveToAdjusted = async (extraMm = 0) => motor.moveToRev(drive.revolutionsForFreeLength(homing.endFreeLengthMm + adjustMm + extraMm), { rpm: homing.rpm });
        // only set when the state changes: setting it every round could undo the 'busy' of a click in between
        const showConfirm = () => {
          this.homingStep = { ...this.homingStep, phase: 'confirm', adjustMm };
          this.activity = `${label}: end found${adjustMm ? `, adjusted ${adjustMm > 0 ? '+' : ''}${adjustMm} mm` : ''}. Confirm, adjust or continue winding`;
        };
        showConfirm();
        for (;;) {
          await tendOthers();
          const request = takeRequest(['confirm', 'jog', 'retry', 'pause']);
          if (!request) {
            await sleep(20);
            continue;
          }
          if (request.action === 'confirm') {
            if (adjustMm) await motor.definePosition(endTurns * motor.pulsesPerRev); // the jogged spot is the end
            ropesFound.add(drive);
            this._log(`${drive.name} homed${adjustMm ? ` (end adjusted ${adjustMm > 0 ? '+' : ''}${adjustMm} mm)` : ''}`);
            return;
          }
          if (request.action === 'jog') {
            adjustMm += request.mm;
            await moveToAdjusted();
            showConfirm();
          } else if (request.action === 'pause') {
            await pause(drive, 'Resume homing comes back here.');
            await holdHere(drive);
            showConfirm();
          } else {
            // a false stop: give some slack, then wind in again
            this.activity = `${label}: giving ${homing.retrySlackMm} mm slack, then winding in again`;
            this._log(`${drive.name}: not the end; winding on`);
            await moveToAdjusted(homing.retrySlackMm);
            const target = drive.revolutionsForFreeLength(homing.endFreeLengthMm + adjustMm + homing.retrySlackMm);
            const deadline = performance.now() + 10000;
            while (Math.abs(turnsOf(drive, (await motor.positions()).feedback) - target) > 0.02 && performance.now() < deadline) await tendOthers();
            break;
          }
        }
      }
    };

    try {
      // 1. everyone soft. Pr0.05 at its maximum (~1 turn): pulling ahead and stalling must not trip the alarm.
      this.activity = 'Homing: all motors pulling softly';
      for (const drive of drives) {
        saved.set(drive, { peakCurrentA: await drive.motor.peakCurrent(), maxFollowingError: await drive.motor.readReg(REG.MAX_FOLLOWING_ERROR) });
        await drive.motor.writeReg(REG.MAX_FOLLOWING_ERROR, 65535);
        await goSoft(drive);
      }
      this.homed = false; // until this homing has found every rope again

      // 2. one position rope at a time to its end
      for (const [count, drive] of positionDrives.entries()) {
        const label = `Homing ${count + 1}/${positionDrives.length}: ${drive.name} (motor ${drive.motorId})`;
        this.homingStep = { rope: drive.name, motorId: drive.motorId, number: count + 1, total: positionDrives.length, phase: 'searching', adjustMm: 0, jogMm: homing.jogMm };
        this.homingRequest = null;
        this._log(label);
        await homeRope(drive, label);
        await goSoft(drive);
      }
      this.homed = true;
      completed = true;
      this._log('Homing done');
    } finally {
      this.activity = '';
      this.homingStep = null;
      this.homingRequest = null;
      // position motors hold where they are, then their normal current and following-error alarm back;
      // tension motors keep pulling softly (and keep the large following-error limit they need)
      for (const [drive, { peakCurrentA, maxFollowingError }] of saved) {
        try {
          if (!completed || !drive.isTension) await holdHere(drive);
          if (!drive.isTension) {
            await drive.motor.setPeakCurrent(peakCurrentA);
            await drive.motor.writeReg(REG.MAX_FOLLOWING_ERROR, maxFollowingError);
          }
        } catch (error) {
          this._error(new Error(`${drive.name}: restoring after homing failed: ${error.message}`));
        }
      }
      // stopped before every rope was found: the homing from before (if any) still holds
      if (!this.homed && previous.homed) {
        for (const [drive, offsetPulses] of previous.offsets) drive.motor.offsetPulses = offsetPulses;
        this.homed = true;
        this._log('Homing stopped: the previous homing still holds');
      }
      if (this.motorState === 'homing') this.motorState = 'idle';
    }
  }

  /**
   * Homing override, for testing without ropes: every motor is declared to be where the simulation's current
   * pose says, so Start motors has (almost) nothing to move. With ropes attached this is wrong (the ropes are
   * wherever they are) and the motors would fight: only for testing.
   */
  async homeHere() {
    this._requireMotorState('idle');
    await this._checkMotorsNotRestarted().catch(() => {}); // a restarted drive gets a fresh reference first
    const targets = this.currentRopeTargets();
    for (const drive of this.enabledDrives) {
      await drive.motor.definePosition(targets[drive.rope.index].revolutions * drive.motor.pulsesPerRev);
      if (drive.isTension) drive.positionKnown = true;
    }
    this.homed = true;
    this._log('Homed here (override, for testing without ropes): every motor is at the simulation\'s current pose');
  }

  /**
   * The screen's homing controls. action: 'confirm' (this rope's end is right: next rope), 'jog' (mm: move the
   * rope, + gives rope, − winds in; on confirm that spot is the end), 'retry' (not the end: some slack, then wind
   * in again), 'pause' (stop, e.g. to untangle) and 'resume'.
   */
  homingAction(action, mm) {
    const phase = this.homingStep?.phase;
    const allowed = { searching: ['pause'], confirm: ['confirm', 'jog', 'retry', 'pause'], paused: ['resume'] }[phase] ?? [];
    if (!allowed.includes(action)) throw new Error(phase ? `Homing can't ${action} now (${phase}).` : 'Homing is not running.');
    if (action === 'jog' && !(Number.isFinite(mm) && Math.abs(mm) <= 100)) throw new Error('Jog needs mm, at most 100.');
    // the phase changes at once, so a double click can't confirm two ropes
    this.homingStep = { ...this.homingStep, phase: action === 'jog' ? phase : 'busy' };
    const pendingJogMm = action === 'jog' && this.homingRequest?.action === 'jog' ? this.homingRequest.mm : 0; // quick clicks add up
    this.homingRequest = { action, mm: action === 'jog' ? mm + pendingJogMm : mm };
  }

  /**
   * Simulated drives: each position rope starts with some rope on its drum, and its shaft can't wind past the
   * point where the rope's end reaches the exit. this.mockStartTurns: the true starting position, for tests.
   */
  _mockEndStops() {
    this.mockStartTurns = {};
    const endStops = {};
    for (const [index, drive] of this.enabledDrives.entries()) {
      if (drive.isTension) continue;
      const endTurns = drive.revolutionsForFreeLength(this.config.homing.endFreeLengthMm);
      const startTurns = endTurns * ((index * 0.37) % 0.9); // somewhere between empty and nearly full
      this.mockStartTurns[drive.motorId] = startTurns;
      const stopPulses = Math.round((endTurns - startTurns) * 10000); // the mock drives have 10000 pulses/turn
      endStops[drive.motorId] = drive.windDirection > 0 ? { max: stopPulses } : { min: stopPulses };
    }
    return endStops;
  }

  /**
   * Motors follow the model, after the transition from wherever they are (after homing, Stop motors, an
   * emergency stop) to the model's current pose. The transition goes through the same command stream as
   * following: every rope's free length goes in a straight (eased) line from where it is to the model's
   * length, all ropes at the same fraction at every moment, plus extra slack (the same on every rope, most
   * halfway, none at the end) at a lower current. Rope lengths of a real pose obey fixed relations (every
   * pair of nodes shares one stretch between two ropes), and so does every straight line between two real
   * poses: the ropes don't fight; slack, current and the weights take up what the start isn't exactly.
   * The model holds still meanwhile and resumes motorDelayMs before the end, so the motors go straight on
   * into it: synced (state 'streaming').
   * Tension ropes whose position isn't known yet (never synced since power-up) hold a pull-ahead from where
   * they are, and take their position from the model at the end.
   */
  async startStreaming() {
    this._requireMotorState('idle');
    if (!this.homed) throw new Error('Home the motors first.');
    const motion = this.config.motion, transition = this.config.transition;
    const drives = this.enabledDrives;
    this.motorState = 'syncing';
    this.abortRequested = false;
    const plans = [];
    const restoreCurrents = async () => {
      for (const plan of plans) {
        if (plan.normalCurrentA === null) continue;
        await plan.drive.motor.setPeakCurrent(plan.normalCurrentA).catch((error) => this._error(error));
        plan.normalCurrentA = null;
      }
    };
    let seconds;
    try {
      await this._checkMotorsNotRestarted();
      this.modelFrozen = true;
      const targets = this.currentRopeTargets();
      this.latestRopeTargets = targets;
      for (const drive of drives) {
        const startTurns = (await drive.motor.positions()).feedback / drive.motor.pulsesPerRev;
        const known = !drive.isTension || !!drive.positionKnown;
        const toMm = targets[drive.rope.index].freeLengthMm;
        plans.push({ drive, startTurns, known, fromMm: known ? drive.freeLengthForRevolutions(startTurns) : toMm, toMm, normalCurrentA: null });
      }
      const furthestMm = Math.max(0, ...plans.map((plan) => Math.abs(plan.toMm - plan.fromMm)));
      seconds = Math.max(transition.minSeconds, motion.motorDelayMs / 1000 + 1, furthestMm / transition.ropeSpeedMmPerS);
      for (const plan of plans) {
        if (plan.drive.isTension) continue;
        const amps = await plan.drive.motor.peakCurrent();
        await plan.drive.motor.setPeakCurrent(amps * transition.currentFraction);
        plan.normalCurrentA = amps;
      }
      await this._applyTensionCurrents({ force: true });
      this._log(`Transition to the simulation: ${furthestMm.toFixed(0)} mm at most, ${seconds.toFixed(1)} s`);
    } catch (error) {
      await restoreCurrents();
      this.modelFrozen = false;
      this.motorState = 'idle';
      throw error;
    }

    const transitionMs = seconds * 1000;
    const transitionTurns = (plan, fraction) => {
      const { drive } = plan;
      if (!plan.known) return plan.startTurns + drive.windDirection * this.config.tension.pullAheadTurns;
      const progress = ease(fraction);
      const freeLengthMm = plan.fromMm + (plan.toMm - plan.fromMm) * progress + transition.slackMm * Math.sin(Math.PI * progress);
      return this._motorTargetTurns(drive, drive.motorTargetForFreeLength(freeLengthMm).revolutions);
    };
    let groupStartMs = null; // when MotorGroup's clock started
    const targetFor = (secondsSinceStart, motorIndex) => {
      const plan = plans[motorIndex];
      const elapsedMs = secondsSinceStart * 1000;
      groupStartMs ??= performance.now() - elapsedMs;
      if (elapsedMs < transitionMs) return transitionTurns(plan, elapsedMs / transitionMs);
      if (plan.drive.isTension && !plan.drive.positionKnown) return transitionTurns(plan, 1); // until it's defined
      return this._motorTargetTurns(plan.drive, this.motorTargets.valueAt(groupStartMs + elapsedMs - motion.motorDelayMs, plan.drive.rope.index));
    };

    const group = new MotorGroup(this.bus, drives.map((drive) => drive.motor), {
      rateHz: motion.updateRateHz,
      lookahead: motion.lookaheadTicks,
      maxRpm: motion.maxRpm,
      ramp: motion.ramp,
      pacedWrites: motion.pacedWrites,
      statusEvery: motion.statusEveryTicks,
      accMs: motion.fastestRampMs,
      decMs: motion.fastestRampMs,
    });
    this.motorGroup = group;
    group.on('overrun', () => this.overrunCount++);
    group.on('motorError', ({ motor, error }) => this._error(new Error(`${motor.name}: ${error.message}`)));
    group.on('alarm', ({ motor, text }) => this._error(new Error(`ALARM ${motor.name}: ${text} (streaming stopped)`)));
    group.on('fatal', ({ error }) => this._error(error));
    this.overrunCount = 0;
    this.tensionCurrentTimer = setInterval(() => this._applyTensionCurrents().catch((error) => this._error(error)), this.config.tension.currentUpdateMs);

    // the transition's end: model on (motorDelayMs early), then synced
    let groupEnded = false;
    const finishTransition = async () => {
      const waitUntil = async (elapsedMs, label) => {
        while (!groupEnded) {
          if (this.abortRequested) return false;
          const left = groupStartMs === null ? transitionMs : groupStartMs + elapsedMs - performance.now();
          if (groupStartMs !== null && left <= 0) return true;
          this.activity = `Transition to the simulation: ${Math.max(0, (groupStartMs === null ? transitionMs : groupStartMs + transitionMs - performance.now()) / 1000).toFixed(0)} s${label}`;
          await sleep(Math.min(50, Math.max(1, left)));
        }
        return false;
      };
      if (!(await waitUntil(transitionMs - motion.motorDelayMs, ''))) return;
      this.modelFrozen = false; // the motors reach this moment of the model exactly when the transition ends
      if (!(await waitUntil(transitionMs, ''))) return;
      for (const [index, plan] of plans.entries()) {
        if (plan.known) continue;
        const { drive } = plan, modelTurns = drive.motorTargetForFreeLength(plan.toMm).revolutions;
        await drive.motor.definePosition(modelTurns * drive.motor.pulsesPerRev); // stalled against its rope, at the model's length
        drive.positionKnown = true;
        // the stream's speed comes from the model's motion (none here): take the pull-ahead at the soft speed
        const targetTurns = this._motorTargetTurns(drive, modelTurns);
        group.lastPulses[index] = Math.round(targetTurns * drive.motor.pulsesPerRev);
        await drive.motor.moveToRev(targetTurns, { rpm: this.config.homing.softRpm });
      }
      await restoreCurrents();
      this.activity = '';
      if (this.motorState === 'syncing' && group.running) {
        this.motorState = 'streaming';
        this._log(`Synced: ${drives.length} motor(s) follow the simulation at ${motion.updateRateHz} Hz, ${motion.motorDelayMs} ms behind it`);
      }
    };
    const transitionDone = finishTransition().catch((error) => {
      this._error(error);
      group.stop();
    });

    this.streamingDone = group
      .start(targetFor)
      .catch((error) => this._error(error))
      .finally(async () => {
        groupEnded = true;
        clearInterval(this.tensionCurrentTimer);
        await transitionDone;
        await restoreCurrents();
        this.motorGroup = null;
        this.modelFrozen = false;
        this.activity = '';
        if (['syncing', 'streaming'].includes(this.motorState)) this.motorState = 'idle';
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
    await this.streamingDone; // streaming has ended (it never rejects)
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
      nodes: this._displayedNodes(),
      inputs: this.inputs,
      simulationRunning: this.simulationRunning,
      motorState: this.motorState,
      homed: this.homed,
      synced: this.motorState === 'streaming',
      homingStep: this.homingStep,
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
