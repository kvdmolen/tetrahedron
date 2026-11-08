// JMC iHSV57-30-14-36-RC integrated AC servo, controlled over RS485 Modbus-RTU.
// Source: manuals/servo/IHSV-RC系列使用手册V1.2.pdf (Chinese). Kept separate from the iCL stepper code.
//
// Connection (manual p.44): RJ45 pin 8 = RS485 A, pin 7 = RS485 B, pin 6 = GND (pins 1-3 are CAN).
//   With a T568B patch cable: pin 6 = green, pin 7 = white/brown, pin 8 = brown. Verify with a multimeter.
// Serial: 8N1 by default (P00-25 = 3), baud set with rotary switch BD (7 = 115200, 5 = 38400, 3 = 9600).
// Slave ID: rotary switches, ID = S2 * 16 + S1 (S2 = 0..7, S1 = 0..F).
// Supply: 24-48 VDC, 36 V typical. Rated 140 W, 0.44 N·m continuous, 3000 rpm; overload 200 % for 3 s.
//
// The register "addresses" are the CiA402 object numbers. 32-bit registers: high word first
// (FORMAT_32BIT = 0, the default, same as the iCL code), and they can only be written with FC 0x10.
// FC 0x10 blocks follow the ORDER OF THE MANUAL'S TABLE, not the numbers, so we write registers one at a time.

export const IHSV = {
  ERROR_CODE: 0x1001, //        RO  internal error
  ALARM_CODE: 0x603f, //        RO  CiA402 error code (see describeAlarm)
  WATCHDOG_TIME: 0x100c, //     RW  if non-zero: drive stops when 0x6039 isn't read within this time
  WATCHDOG_FACTOR: 0x100d, //   RW
  FORMAT_32BIT: 0x6000, //      RW  0 = high word first
  WATCHDOG_READ: 0x6039, //     RO  read this to keep the watchdog happy
  CONTROL_WORD: 0x6040, //      WO
  STATUS_WORD: 0x6041, //       RO
  OPERATION_MODE: 0x6060, //    WO  1 position, 3 velocity, 4 torque, 6 homing
  OPERATION_MODE_ACTUAL: 0x6061,
  ACTUAL_POSITION: 0x6064, //   RO  int32
  ACTUAL_SPEED: 0x606c, //      RO  int32, rpm
  TARGET_TORQUE: 0x6071, //     RW  int16, per mille of rated torque, -1000..1000
  TORQUE_LIMIT: 0x6072, //      RW  per mille of rated torque, 0..1000
  ACTUAL_TORQUE: 0x6077, //     RO  int16, per mille of rated torque
  TARGET_POSITION: 0x607a, //   RW  int32
  TARGET_SPEED: 0x6081, //      RW  int32, 0.1 rps (also the speed LIMIT in torque mode)
  ACCELERATION: 0x6083, //      RW  0.1 rps/s
  DECELERATION: 0x6084, //      RW  0.1 rps/s
  TORQUE_SLOPE: 0x6087, //      RW  per mille of rated torque per second
};

export const IHSV_MODE = { POSITION: 1, VELOCITY: 3, TORQUE: 4, HOMING: 6 };

// Control word values (CiA402 state machine, manual table 43). Bit4 = start, bit8 = pause.
export const IHSV_CONTROL = {
  INITIALISE: 0x0001,
  SWITCH_ON: 0x0003,
  ENABLE: 0x000f,
  DISABLE: 0x0007,
  START: 0x001f, //       enable + bit4
  FAULT_RESET: 0x0080, // bit7 0 -> 1
};

export const IHSV_RATED_TORQUE_NM = 0.44;

// Alarm list, manual table 19 (p.38-39). The drive shows them as AL.xxx.
export const IHSV_ALARMS = {
  51: 'EEPROM parameter error', 62: 'parameter storage error', 63: 'over-current', 100: 'parameter combination error',
  105: 'electronic gear setting error', 110: 'power-cycle needed after a parameter change', 120: 'servo-on command invalid',
  401: 'under-voltage', 402: 'over-voltage', 410: 'overload (instantaneous maximum load)', 411: 'drive overload',
  412: 'motor overload (continuous maximum load)', 420: 'overspeed', 421: 'runaway detected', 422: 'runaway (flying) fault',
  440: 'heatsink over-temperature', 441: 'motor over-temperature', 501: 'position error too large',
  550: 'inertia identification failed', 551: 'homing timeout', 552: 'angle identification failed',
  610: 'encoder disconnected', 611: 'encoder Z signal lost',
  900: 'WARNING position error too large', 901: 'WARNING position error too large at servo-on', 910: 'WARNING motor overload',
  912: 'WARNING drive overload', 941: 'WARNING power-cycle needed for a parameter change', 942: 'WARNING EEPROM written too often',
  943: 'WARNING serial communication error', 971: 'WARNING under-voltage',
};

/** Alarm code -> text. The drive's exact encoding isn't documented: try the value as AL number, decimal and hex digits. */
export function describeAlarm(code) {
  if (!code) return 'no alarm';
  const asHexDigits = Number(code.toString(16)); // e.g. 0x0501 -> 501
  const text = IHSV_ALARMS[code] ?? IHSV_ALARMS[asHexDigits] ?? IHSV_ALARMS[code & 0x0fff];
  return `code ${code} (0x${code.toString(16)})${text ? ` = AL.${IHSV_ALARMS[code] ? code : asHexDigits}: ${text}` : ' (unknown, see manual table 19)'}`;
}

export function describeStatusWord(status) {
  const flags = [];
  if (status & 0x0004) flags.push('enabled');
  if (status & 0x0008) flags.push('FAULT');
  if (status & 0x0020) flags.push('quick-stop');
  if (status & 0x0080) flags.push('warning');
  if (status & 0x0200) flags.push('moving');
  if (status & 0x0400) flags.push('target reached');
  if (status & 0x1000) flags.push('torque reached');
  if (status & 0x2000) flags.push('following error');
  return flags.join(', ') || 'idle';
}
