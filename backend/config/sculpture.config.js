// Sculpture settings. Values marked MEASURE are placeholders until installation.
import { ROPES } from '../../shared/tetraGeometry.js';
import { DEFAULT_RS485_PORT, DEFAULT_BAUD_RATE } from '../src/serialPorts.js';

export default {
  server: { httpPort: 4000 },

  serial: {
    path: DEFAULT_RS485_PORT, // null = auto-detect the FTDI converter
    baudRate: DEFAULT_BAUD_RATE,
  },

  simulation: {
    pullStrength: 0.05, // how fast nodes follow their targets (same as the original frontend)
  },

  // Constant-tension ropes: the 4 direct ropes (motor IDs 1, 6, 11, 16 with the default IDs below).
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

  pulley: {
    ropeThicknessMm: 6,
    coreRadiusMm: 40, //  MEASURE: radius of the empty drum
  },

  motion: {
    updateRateHz: 5, //      position commands per motor per second (5 is fine; 10 needs the faster bus timing)
    lookaheadTicks: 3, //    see MotorGroup
    motorDelayMs: 800, //    motors play the model this long after the screen (must be > lookahead time)
    ramp: 'adaptive', //     'adaptive' or 'fixed' acceleration per command
    fastestRampMs: 100, //   ms per 1000 rpm
    maxRpm: 300,
    homingRpm: 30, //        speed while winding to the home pose, one motor at a time
    syncRpm: 30, //          speed when moving to the model's pose before streaming starts
  },

  /**
   * One entry per rope, index = rope index in shared/tetraGeometry.js (viaNode * 4 + endNode).
   *   motorId        Modbus slave ID (DIP switches)
   *   windDirection  +1 if positive motor turns wind rope ON to the drum, -1 if they unwind
   *   ropeLengthMm   MEASURE: free rope length with an EMPTY drum (= the home reference)
   *   minFreeLengthMm  never pull the rope shorter than this (keeps nodes out of the corners)
   *   enabled        false = this motor is not connected / not driven
   */
  drives: ROPES.map((rope) => ({
    ropeIndex: rope.index,
    motorId: rope.index + 1,
    windDirection: 1,
    ropeLengthMm: rope.isDirect ? 1500 : 2800,
    minFreeLengthMm: 100,
    enabled: true,
  })),
};
