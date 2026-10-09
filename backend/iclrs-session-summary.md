# iCL-RS stepper over RS485 from Mac M4 — session summary

## Goal
Control 16 motors from a Mac via Node.js: 12 with streaming position control (~10 Hz per motor, driven by a math algorithm, motors connected through ropes), 4 needing constant torque. Starting with one prototype motor.

## Hardware
- **Motor:** StepperOnline/Leadshine **iCL57-RS13** (NEMA 23, 1.3 N·m, 20–50 VDC, 0.5–4.5 A peak). Slave ID 1 set via DIP switches (SW1 off, SW2–5 on).
- **Converter:** Ben's Electronics USB 2.0 RS485 (FTDI, VID 0403 / PID 6001). Port: `/dev/cu.usbserial-A50285BI` (also appears as `/dev/tty.usbserial-A50285BI`; prefer `cu.`).
- **PSU:** 48 V Meanwell. OK for the iCL57 (max 50 V) but only 2 V margin. Meanwell trim pots can exceed 50 V, so measure before connecting. The drive reports bus voltage at register `0x0177` (0.1 V units). **Not** OK for iCL42 models (max 36 V).

## Key facts from the manual
- RS485 is only the electrical layer. The drive speaks **Modbus RTU only** (FC 03 read, 06 write single, 10h write multiple; CRC-16, low byte first). No raw/ASCII mode, no step/direction.
- Modes: Profile Position, Profile Velocity, Homing. **No torque mode.**
- Connector **CN3 (RS485)**: pin 1 = RS485+, pin 2 = RS485−, pins 3 and 4 = GND. Two RS485 connectors on the motor (IN/OUT); try either. The manual gives no wire colours and no pin-1 orientation, so identify wires with a multimeter.
- **DIP switches:** SW1–5 slave ID (off=1, on=0); SW6–7 baud (both ON = 115200, SW6 off/SW7 on = 38400, SW6 on/SW7 off = 19200, both off = software setting, factory value 38400); SW8 = 120 Ω terminator (ON for the last device on the bus). Power-cycle after changing DIPs.
- Serial format default: 8N1 (Pr5.24 = 4).
- **Streaming move ("immediate trigger", manual 5.5.4):** one FC10 write to `0x6200` with 8 registers: mode, posHi, posLo, rpm, acc (ms/1000rpm), dec, pause, `0x0010` (trigger). Mode `0x01` = absolute position, `0x41` = relative, `0x11` = absolute with interrupt bit (my choice, so a new command replaces a running move; verify smoothness on real hardware).
- Position units are pulses (Pr0.00, default 10000 P/R). The encoder is single-turn, so use `0x21` to `0x6002` (set zero) at every power-up.
- Useful registers: `0x0177` bus voltage, `0x0191` peak current (0.1 A), `0x1003` motion status, `0x1010–0x1015` following error / profile / feedback positions (int32 hi/lo), `0x2203` alarm, `0x1801` control word (`0x1111` clear alarm, `0x2211` save to EEPROM), `0x6002` PR control (`0x40` quick stop).
- Bus timing (manual): ~3 ms per message at 115200, ~7 ms at 38400, ~25 ms at 9600. **12 motors at 10 Hz needs 115200.** Watch for FTDI USB latency (up to ~16 ms per reply); run `bench` to measure.
- DI1 is enable (normally closed) by default, so the motor is enabled and locks the shaft at power-up.

## Constant-torque motors (4 of 16)
No torque setting exists. Options: limit peak current (`Pr5.00`, `0x0191`) and let the motor stall or push against the load, or run low-rpm velocity mode into the load. Beware: holding/standby current drops to 50% (`Pr5.01`, `Pr5.02`, `Pr5.33`) when stopped, and it's a current ceiling rather than regulated torque. Stalling causes heat. A servo would suit accurate tension control better.

## Code delivered: `iclrs-motor.zip` (Node ≥18, ESM, dependency: `serialport`)
- `src/ModbusRtuBus.js` Modbus RTU master (queue, retries, CRC, broadcast, parity option)
- `src/IclRsMotor.js` per-drive API (`moveToRev`, `setZero`, `quickStop`, `positions`, `status`, `alarm`, `setPeakCurrent`, `saveToEeprom`...)
- `src/MotorGroup.js` fixed-rate loop, `targetFn(t, i) -> revolutions`, auto speed per tick, round-robin fault polling, error limits, broadcast e-stop
- `src/MockPort.js` simulated drives (`--mock`)
- `bin/cli.js` commands: `ports`, `scan`, `probe`, `info`, `bench`, `current`, `zero`, `move`, `sine`, `estop`
- `npm test`: CRC vectors from the manual plus a simulated 12-motor, 10 Hz run (passes, 0 overruns). **Not yet tested on real hardware.**

## Current status / open issue
`scan` finds nothing at 38400. The **RX LED on the converter flashes during `probe`**, so the converter transmits and something comes back. Two possibilities:
1. **Echo:** the converter hears its own transmission (raw bytes = my request `01 03 01 77 00 01 ...`). Then I need to add an echo-filter option, and the motor still isn't answering, so check polarity, ground, power, terminator.
2. **Wrong baud/parity:** raw bytes are garbage rather than my request, and wiring is fine. `probe` keeps trying other settings.

**Next step:** run `node bin/cli.js probe --port /dev/cu.usbserial-A50285BI` and read the output. A line starting `***` gives the working baud/parity (`probe` doesn't yet pass a non-"none" parity into the other commands, so a `--parity` CLI option would be needed).

Checklist if silent: swap the A/B wires, connect GND, confirm green PWR LED is on (no blinking red), try the other RS485 connector, SW8 ON.

## Next steps
1. Get comms working (`probe`, then `info`).
2. Set the motor's baud to 115200 via DIP (SW6, SW7 ON) and power-cycle.
3. First motion test at low current: `current 1.5`, `zero`, `move 1 --rpm 60`, `sine --ids 1`. Check that the interrupt bit gives smooth streaming.
4. `bench` to confirm the timing budget for 12 motors. If FTDI latency is a problem, add a wire-time-paced mode that doesn't wait for replies.
5. Write the real algorithm as `(t, i) => revolutions` and plug it into `MotorGroup`, with soft limits (`minRev`, `maxRev`).
6. Later: code for the 4 constant-torque motors (current limit plus stall or velocity), and scale to 16 IDs (the drive supports IDs 1–31).
