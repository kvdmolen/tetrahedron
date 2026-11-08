// Sculpture settings. Values marked MEASURE are placeholders until installation.
import { fileURLToPath } from 'node:url';
import { ROPES, MAX_POSITION_ROPE_LENGTH_MM } from '../../shared/tetra.js';
import { DEFAULT_RS485_PORT, DEFAULT_BAUD_RATE } from '../src/serialPorts.js';

// Which way each motor turns to WIND its rope onto the drum, looking at the face of the shaft (2026-11-07).
// Motor IDs; all others wind counter-clockwise.
const WINDS_CLOCKWISE = new Set([1, 4, 5, 8, 9, 11, 13, 15]);

// Are the 4 suspension ropes A, B, C, D (motor IDs 1, 5, 9, 13) on motors? false = they hang on weights
// (the prototype): those motors are not connected, and the software leaves them out.
const SUSPENSION_MOTORS = false;

export default {
  server: { httpPort: 4000 },

  // Saved timelines, one <name>.json per timeline
  timelinesDirectory: fileURLToPath(new URL('../timelines', import.meta.url)),

  serial: {
    path: DEFAULT_RS485_PORT, // null = auto-detect the FTDI converter
    baudRate: DEFAULT_BAUD_RATE,
  },

  // Overrides for the model's tuning (see DEFAULT_TUNING in shared/tetra.js), e.g. { maxNodeSpeedMmPerS: 1000 }
  model: {},

  // Constant-tension ropes: the 4 suspension ropes A, B, C, D (motor IDs 1, 5, 9, 13 with the default IDs below).
  // Measured 2026-10-09 on the iCL57-RS13 with `cli.js tensiontest` (rope on ~4-5 windings, about 65 mm radius):
  //   0.8 A ~ 0.35 kg, 1.5 A ~ 1 kg, 2.5 A ~ 2 kg, 4.5 A (max) ~ 3-4 kg.
  // Stalled the drive pulls with constant force (not spring-like; --pull 0.15 vs 0.4 and Kp made no difference),
  // smooth, no buzzing, not warm at 0.8 A. The following-error alarm comes after ~1 turn (Pr0.05 = 65535 = max).
  tension: {
    currentA: 1.5, //            current that gives the wanted force at referenceRadiusMm (1.5 A ~ 1 kg at 65 mm)
    referenceRadiusMm: 65, //    radius of the measurement above; current is scaled by (drum radius / this)
    maxCurrentA: 3, //           never more than this
    pullAheadTurns: 0.3, //      commanded this much further wound-in than the model, so the motor always stalls
    currentUpdateMs: 1000, //    how often the radius-scaled current is re-checked (sent only if it changed >= 0.1 A)
  },

  motor: {
    // Which way the shaft turns for increasing positions, looking at the face of the shaft. Set by drive
    // parameter Pr0.03 "Motor direction" (factory 0 = CW according to the manual; leave it at 0 on every drive).
    // VERIFY: `node bin/cli.js take 0.25 --ids N` prints which way the shaft should turn; watch that it does.
    positiveRotation: 'ccw',
  },

  pulley: {
    ropeThicknessMm: 4, // per layer on the drum: the rope flattens a little when wound
    coreRadiusMm: 30, //   radius of the empty drum (60 mm diameter)
  },

  motion: {
    updateRateHz: 5, //      position commands per motor per second (5 is fine; 10 needs the faster bus timing)
    lookaheadTicks: 3, //    see MotorGroup
    motorDelayMs: 800, //    motors play the model this long after the screen (must be > lookahead time)
    ramp: 'adaptive', //     'adaptive' or 'fixed' acceleration per command
    pacedWrites: true, //    don't wait ~16 ms for each motor's reply (USB converter delay); ~3x more motors per tick
    statusEveryTicks: 3, //  check one motor's alarm flag every N ticks (round-robin); each check costs ~30 ms of bus time
    fastestRampMs: 100, //   ms per 1000 rpm
    maxRpm: 1000, //         commands are capped at this; the model's speed limit keeps them well below it
  },

  // Transition: how the motors get from wherever they are (after homing, Stop motors, an emergency stop) to the
  // simulation's pose before they follow it (see SculptureController.startStreaming). Every rope in a straight
  // line, all at the same pace, with some extra slack, at a lower current; then the status is SYNCED.
  transition: {
    minSeconds: 4, //         at least this long (also at least motorDelayMs + 1 s)
    ropeSpeedMmPerS: 100, //  longer when a rope has further to go
    slackMm: 20, //           extra free length on every rope, most halfway, none at the end
    currentFraction: 0.5, //  position motors at this fraction of their peak current meanwhile
  },

  // Automatic homing (SculptureController.home): one position rope at a time winds in slowly until it can't
  // go further (its end is at the exit point), which gives its exact position. Meanwhile all other motors pull
  // softly: their ropes stay just taut, slack is wound in, and they give way when pulled.
  homing: {
    forceFraction: 0.5, //   winding-in force: this fraction of the motor's normal peak current
    rpm: 20, //              winding-in speed
    endFreeLengthMm: 30, //  MEASURE: free length left when the rope's end is at its exit point (knots)
    stallLagTurns: 0.25, //  end reached when the shaft lags its command this much (it can't follow any more)
    softCurrentA: 0.4, //    current of the other motors meanwhile: just enough to keep their ropes taut
    softPullTurns: 0.2, //   soft motors always aim this much further wound-in than they are
    softRpm: 20,
    stepByStep: true, //     after each rope: wait for Confirm on the screen (or jog, or continue winding)
    jogMm: 5, //             step of the screen's - / + buttons at that moment
    retrySlackMm: 50, //     "Continue winding": give this much rope first, then wind in again
  },

  /**
   * One entry per rope, index = rope index in shared/tetra.js: per node A-D, 4 ropes in the order
   * suspension, opposite node, left side node, right side node (A, A:AB, A:AC, A:AD, B, ...).
   *   motorId        Modbus slave ID (DIP switches)
   *   windRotation   'cw' or 'ccw': which way this motor turns to wind rope onto its drum (see WINDS_CLOCKWISE)
   *   ropeLengthMm   free rope length with an EMPTY drum, from the exit point at the corner to the rope's end
   *                  (= motor position 0, the home reference). Position ropes: exactly the longest they can
   *                  get, 2√2 × box (MAX_POSITION_ROPE_LENGTH_MM, 1929 mm), so "empty drum" is a real pose.
   *   minFreeLengthMm  never pull the rope shorter than this (a safety margin against bad targets)
   *   enabled        false = this motor is not connected / not driven (see SUSPENSION_MOTORS; --motors overrides)
   */
  drives: ROPES.map((rope) => ({
    ropeIndex: rope.index,
    motorId: rope.index + 1,
    windRotation: WINDS_CLOCKWISE.has(rope.index + 1) ? 'cw' : 'ccw',
    ropeLengthMm: rope.isDirect ? 1500 : MAX_POSITION_ROPE_LENGTH_MM, // suspension ropes: MEASURE
    minFreeLengthMm: 30,
    enabled: SUSPENSION_MOTORS || !rope.isDirect,
  })),
};
