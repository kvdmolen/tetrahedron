// Register map for iCL-RS (addresses from the manual, section 4.3 / Appendix A).
// 32-bit "PrX.XX" parameters occupy two registers; the address listed in the
// manual is the LOW register, so single reads/writes of that address work fine.

export const REG = {
  // --- basic parameters ---
  PULSES_PER_REV: 0x0001, // Pr0.00  P/R (default 10000)
  FORCE_ENABLE: 0x000f, //   Pr0.07  1 = enable regardless of DI1
  BUS_VOLTAGE: 0x0177, //    Pr4.27  unit 0.1 V
  PEAK_CURRENT: 0x0191, //   Pr5.00  unit 0.1 A
  RS485_BAUD: 0x01bd, //     Pr5.22  0:2400 1:4800 2:9600 3:19200 4:38400 5:57600 6:115200
  RS485_ID: 0x01bf, //       Pr5.23

  // --- status (read only) ---
  MOTION_STATUS: 0x1003, // bit0 fault, bit1 enabled, bit2 running, bit4 cmd done, bit5 path done, bit6 homed
  FOLLOW_ERR_HI: 0x1010, // int32 hi/lo, pulses
  PROFILE_POS_HI: 0x1012, // int32 hi/lo, commanded (profile) position
  FEEDBACK_POS_HI: 0x1014, // int32 hi/lo, encoder feedback position in ENCODER counts (65536/rev), not pulses
  CONTROL_WORD: 0x1801, //  write-only commands, see CTRL
  SAVE_STATUS: 0x1901, //   0x5555 ok, 0xAAAA failed
  ALARM: 0x2203, //         current alarm bitmask

  // --- PR mode ---
  PR_GLOBAL: 0x6000, //  Pr8.00  bit0 CTRG edge, bit1 soft limit, bit2 home on power-up
  PR_CONTROL: 0x6002, // Pr8.02  trigger register
  PR0_BASE: 0x6200, //   Pr9.00..Pr9.07 (8 consecutive registers for path 0)
};

export const CTRL = {
  RESET_ALARM: 0x1111,
  RESET_HISTORY: 0x1122,
  SAVE_ALL: 0x2211,
  RESET_PARAMS: 0x2222,
  FACTORY_RESET: 0x2233,
  SAVE_MAPPING: 0x2244,
};

export const PR_CMD = {
  HOME: 0x20,
  SET_ZERO: 0x21,
  QUICK_STOP: 0x40,
  runPath: (p) => 0x10 + p,
};

export const PR_MODE = {
  POSITION: 0x1,
  VELOCITY: 0x2,
  HOMING: 0x3,
  // bit4 "INS". Measured on an iCL57-RS13 (interrupttest): with INS=1 a new PR0 is IGNORED while a
  // move runs; with INS=0 (plain 0x01) the new PR0 takes over immediately. So streaming uses INS=0.
  INTERRUPT: 0x10,
  OVERLAP: 0x20, //   bit5
  RELATIVE: 0x40, //  bit6 (0 = absolute)
};

export const ALARMS = {
  0x01: 'over-current',
  0x02: 'over-voltage',
  0x40: 'current sampling fault',
  0x80: 'failed to lock shaft',
  0x100: 'auto-tuning fault',
  0x200: 'EEPROM fault',
};

export const BAUD_CODES = { 0: 2400, 1: 4800, 2: 9600, 3: 19200, 4: 38400, 5: 57600, 6: 115200 };

export function describeAlarm(mask) {
  if (!mask) return 'none';
  return Object.entries(ALARMS)
    .filter(([bit]) => mask & Number(bit))
    .map(([, name]) => name)
    .join(', ') || `unknown (0x${mask.toString(16)})`;
}
