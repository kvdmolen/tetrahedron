// JMC iHSV servo P-parameters, from the parameter table in manuals/servo/IHSV-RC系列使用手册V1.2.pdf (p.25-28).
//
// Found on 2026-10-10: over the RS232 tuning port (57600 8E1) parameter Pgg-ii is Modbus register gg*100 + ii
// (decimal), e.g. P04-05 -> 405 = 0x0195. NOT available over RS485. Addresses that don't exist answer with
// their own address as value, so "value === address" means "not a real parameter".
//
// scale: the manual shows some values with decimals (48.0, 0.84); those are presumably stored multiplied
// (x10 / x100): confirmed on the drive 2026-10-10 (P02-00 48.0 = raw 480, P02-04 0.5 = raw 50).
// applies: 'now' = takes effect immediately, 'restart' = after a power cycle.

export const RS232_TUNING_PORT = '/dev/cu.usbserial-AC005EJ0';  // the Elecbee USB-RS232 cable on the studio Mac
export const RS232_BAUD_RATE = 57600; //                          fixed (manual table 22)
export const RS232_PARITY = 'even';

export const IHSV_PARAMETERS = [
  // P00 motor and drive
  { code: 'P00-01', name: 'motor rated speed', unit: 'rpm', applies: 'restart' },
  { code: 'P00-02', name: 'motor rated torque', unit: 'N·m', scale: 100, applies: 'restart' },
  { code: 'P00-04', name: 'motor rotor inertia (needed for P01-04)', unit: 'kg·cm²', scale: 100, applies: 'restart' },
  { code: 'P00-21', name: 'RS232 baud rate (0 9600, 1 19200, 2 57600, 3 115200)', default: 2, applies: 'restart' },
  { code: 'P00-23', name: 'slave address (ID)', default: 1, applies: 'restart' },
  { code: 'P00-24', name: 'Modbus baud rate (7 = 115200)', applies: 'restart' },
  { code: 'P00-25', name: 'Modbus parity (3 = none, 1 stop bit)', default: 3, applies: 'restart' },
  { code: 'P00-26', name: 'Modbus reply delay', unit: 'ms', default: 0, applies: 'restart' },
  { code: 'P00-27', name: 'CANopen baud rate (7 = 1 Mbps)', applies: 'restart' },
  { code: 'P00-42', name: 'over-voltage threshold', unit: 'V', default: 0, applies: 'restart' },
  // P01 main control
  { code: 'P01-01', name: 'control mode (4 = bus)', default: 4, applies: 'now' },
  { code: 'P01-02', name: 'auto-tuning mode (0 manual, 1 standard, 2 positioning)', default: 1, applies: 'now' },
  { code: 'P01-03', name: 'rigidity / stiffness (0-31, higher = stiffer)', default: 13, applies: 'now' },
  { code: 'P01-04', name: 'load inertia ratio', scale: 100, default: 1, applies: 'now' },
  // P02 gains (with auto-tuning 1/2 these follow P01-03 and manual changes are ignored)
  { code: 'P02-00', name: 'position gain 1 (standstill)', unit: '1/s', scale: 10, default: 48, applies: 'now' },
  { code: 'P02-01', name: 'position gain 2 (moving)', unit: '1/s', scale: 10, default: 57, applies: 'now' },
  { code: 'P02-03', name: 'speed feed-forward gain', unit: '%', scale: 10, default: 30, applies: 'now' },
  { code: 'P02-04', name: 'speed feed-forward smoothing', unit: 'ms', scale: 100, default: 0.5, applies: 'now' },
  { code: 'P02-10', name: 'speed gain 1', unit: 'Hz', scale: 10, default: 27, applies: 'now' },
  { code: 'P02-11', name: 'speed integral time 1', unit: 'ms', scale: 10, default: 10, applies: 'now' },
  { code: 'P02-13', name: 'speed gain 2', unit: 'Hz', scale: 10, default: 27, applies: 'now' },
  { code: 'P02-14', name: 'speed integral time 2', unit: 'ms', scale: 10, default: 1000, applies: 'now' },
  { code: 'P02-19', name: 'torque feed-forward gain', unit: '%', default: 0, applies: 'now' },
  // P03 position
  { code: 'P03-05', name: 'in-position condition', default: 1, applies: 'now' },
  { code: 'P03-06', name: 'in-position range', unit: 'encoder counts', default: 30, applies: 'now' },
  { code: 'P03-09', name: 'command pulses per turn', default: 4000, applies: 'restart' },
  { code: 'P03-15', name: 'max position error before alarm', unit: 'command units x10', default: 0, applies: 'now' },
  { code: 'P03-16', name: 'position command smoothing filter', unit: 'ms', scale: 10, default: 0, applies: 'now' },
  // P04 speed
  { code: 'P04-05', name: 'overspeed alarm', unit: 'rpm', default: 6400, applies: 'now' },
  { code: 'P04-06', name: 'forward speed limit', unit: 'rpm', default: 5000, applies: 'now' },
  { code: 'P04-07', name: 'reverse speed limit', unit: 'rpm', signed: true, default: -5000, applies: 'now' },
  { code: 'P04-14', name: 'acceleration time', unit: 'ms per 1000 rpm', default: 500, applies: 'now' },
  { code: 'P04-15', name: 'deceleration time', unit: 'ms per 1000 rpm', default: 500, applies: 'now' },
  // P05 torque
  { code: 'P05-10', name: 'forward torque limit', unit: '% of rated', scale: 10, default: 200, applies: 'now' },
  { code: 'P05-11', name: 'reverse torque limit', unit: '% of rated', scale: 10, signed: true, default: -200, applies: 'now' },
  // P08 advanced
  { code: 'P08-19', name: 'speed feedback low-pass filter', unit: 'ms', scale: 100, default: 0.8, applies: 'now' },
  { code: 'P08-20', name: 'torque command filter', unit: 'ms', scale: 100, default: 0.84, applies: 'now' },
];

/** 'P04-05' -> 405 */
export function parameterAddress(code) {
  const match = /^P(\d\d)-(\d\d)$/i.exec(code);
  if (!match) throw new Error(`Not a parameter code: ${code} (expected e.g. P01-03)`);
  return Number(match[1]) * 100 + Number(match[2]);
}

export function findParameter(code) {
  return IHSV_PARAMETERS.find((parameter) => parameter.code.toUpperCase() === code.toUpperCase());
}

/** Raw register value -> value in the manual's units. */
export function fromRaw(parameter, raw) {
  const signedRaw = parameter?.signed ? (raw << 16) >> 16 : raw;
  return signedRaw / (parameter?.scale ?? 1);
}

/** Value in the manual's units -> raw register value. */
export function toRaw(parameter, value) {
  return Math.round(value * (parameter?.scale ?? 1)) & 0xffff;
}
