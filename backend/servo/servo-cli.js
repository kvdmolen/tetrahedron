#!/usr/bin/env node
// Test tool for the JMC iHSV57 servo over the same RS485 converter (separate from bin/cli.js).
//
//   node servo/servo-cli.js info                    status, mode, position, speed, torque
//   node servo/servo-cli.js probe                   look for the servo at every baud rate (ID --id)
//   node servo/servo-cli.js torquetest --torque 300 --speedlimit 0.5 --seconds 20
//        real torque mode: pulls with 300 per mille (30 %) of rated torque, never faster than 0.5 turns/s.
//        Negative --torque pulls the other way. Ctrl-C (or the end) sets torque 0 and disables the motor.
//   node servo/servo-cli.js findparams              READ-ONLY: look for the P-parameters (gains, error limit) over Modbus
//   node servo/servo-cli.js param <address> [value] read (or write) one register, e.g. 'param 0x0103'
//   node servo/servo-cli.js scan [--from 0x0000] [--to 0xffff]
//        READ-ONLY sweep of every register address (~20 min for all). Saves to servo-scan.jsonl and resumes
//        where it stopped; prints readable addresses and looks for the P-parameters' factory defaults.
//        --width 2: read 2 registers per address, to find 32-bit values (e.g. --from 0x2000 --to 0x5fff)
//   node servo/servo-cli.js watch                   motor OFF: prints position; turn the shaft one turn by hand
//   node servo/servo-cli.js sine --amp 1 --freq 0.2 --rate 10 --lookahead 3 --countsperturn 4000
//        position streaming (profile position, "change immediately"), the servo version of bin/cli.js sine
//        --oneframe: experiment with one message per update instead of two
//        --paced: don't wait for each reply (bus-ms column drops from ~32 to ~8)
//   RS232 tuning port: add --port /dev/cu.<the RS232 adapter> --baud 57600 --parity even (e.g. to findparams)
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ModbusRtuBus } from '../src/ModbusRtuBus.js';
import { DEFAULT_RS485_PORT, DEFAULT_BAUD_RATE } from '../src/serialPorts.js';
import { IHSV, IHSV_MODE, IHSV_CONTROL, IHSV_RATED_TORQUE_NM, describeStatusWord } from './ihsvRegisters.js';

// allow negative numbers: '--torque -300' -> '--torque=-300'
const cliArgs = [];
for (const token of process.argv.slice(2)) {
  const previous = cliArgs[cliArgs.length - 1];
  if (/^-\d/.test(token) && previous?.startsWith('--') && !previous.includes('=')) cliArgs[cliArgs.length - 1] = `${previous}=${token}`;
  else cliArgs.push(token);
}
const { values: options, positionals: [command, argument, argument2] } = parseArgs({
  args: cliArgs,
  allowPositionals: true,
  options: {
    port: { type: 'string', default: DEFAULT_RS485_PORT },
    baud: { type: 'string', default: String(DEFAULT_BAUD_RATE) },
    id: { type: 'string', default: '1' },
    torque: { type: 'string', default: '200' }, //       per mille of rated torque
    speedlimit: { type: 'string', default: '0.5' }, //   turns per second
    slope: { type: 'string', default: '1000' }, //       per mille of rated torque per second
    seconds: { type: 'string', default: '20' },
    amp: { type: 'string', default: '1' }, //            turns
    freq: { type: 'string', default: '0.2' }, //         Hz
    rate: { type: 'string', default: '10' }, //         position updates per second
    lookahead: { type: 'string', default: '3' }, //      ticks
    countsperturn: { type: 'string', default: '4000' }, // target-position units per turn (P03-09, default 4000)
    acc: { type: 'string', default: '200' }, //          0.1 turns/s^2 (200 = 20 turns/s^2)
    parity: { type: 'string', default: 'none' }, //     'even' for the RS232 tuning port (57600 8E1)
    oneframe: { type: 'boolean', default: false }, //   experiment: one message per update instead of two
    paced: { type: 'boolean', default: false }, //      don't wait for replies (see src/ModbusRtuBus.js)
    from: { type: 'string', default: '0x0000' },
    to: { type: 'string', default: '0xffff' },
    out: { type: 'string' }, //                          default servo-scan.jsonl (servo-scan-32bit.jsonl with --width 2)
    width: { type: 'string', default: '1' }, //         registers per read: 2 finds 32-bit values that refuse 1-register reads
  },
});
const servoId = Number(options.id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toInt32 = ([high, low]) => ((high << 16) | low) | 0;
const toInt16 = (value) => (value << 16) >> 16;
const split32 = (value) => [(value >> 16) & 0xffff, value & 0xffff];

async function openBus(baudRate = Number(options.baud), quick = false) {
  const bus = new ModbusRtuBus({ path: options.port, baudRate, parity: options.parity, ...(quick ? { timeoutMs: 150, retries: 0 } : {}) });
  await bus.open();
  return bus;
}

async function readState(bus) {
  const read16 = async (address) => (await bus.readHolding(servoId, address, 1))[0];
  const read32 = async (address) => toInt32(await bus.readHolding(servoId, address, 2));
  const status = await read16(IHSV.STATUS_WORD);
  await read16(IHSV.WATCHDOG_READ); // keeps the drive's optional comms watchdog satisfied
  return {
    status,
    mode: toInt16(await read16(IHSV.OPERATION_MODE_ACTUAL)),
    position: await read32(IHSV.ACTUAL_POSITION),
    speedRpm: await read32(IHSV.ACTUAL_SPEED),
    torquePerMille: toInt16(await read16(IHSV.ACTUAL_TORQUE)),
    errorCode: await read16(IHSV.ERROR_CODE),
  };
}

async function info() {
  const bus = await openBus();
  try {
    const state = await readState(bus);
    console.log(`Servo ID ${servoId} on ${options.port} @ ${options.baud}`);
    console.log(`  status 0x${state.status.toString(16).padStart(4, '0')} (${describeStatusWord(state.status)}), mode ${state.mode}, error code ${state.errorCode}`);
    console.log(`  position ${state.position}, speed ${state.speedRpm} rpm, torque ${state.torquePerMille} per mille of rated`);
    for (const [name, address] of [['watchdog time', IHSV.WATCHDOG_TIME], ['watchdog factor', IHSV.WATCHDOG_FACTOR], ['32-bit format', IHSV.FORMAT_32BIT]]) {
      console.log(`  ${name}: ${(await bus.readHolding(servoId, address, 1))[0]}`);
    }
  } finally {
    await bus.close();
  }
}

async function probe() {
  console.log(`Looking for servo ID ${servoId} on ${options.port} (8N1)...`);
  for (const baudRate of [115200, 38400, 57600, 19200, 9600, 4800, 2400, 1200]) {
    const bus = await openBus(baudRate, true);
    try {
      const status = (await bus.readHolding(servoId, IHSV.STATUS_WORD, 1))[0];
      console.log(`  ${baudRate}: *** ANSWER, status 0x${status.toString(16)} (${describeStatusWord(status)})`);
      return;
    } catch (error) {
      console.log(`  ${baudRate}: ${error.constructor.name === 'ModbusTimeout' ? 'silence' : error.message}`);
    } finally {
      await bus.close();
    }
  }
  console.log('No answer. Check A/B (RJ45 pin 8 = A, 7 = B, 6 = GND), the BD and S1/S2 rotary switches, and power.');
}

async function torqueTest() {
  const torquePerMille = Math.max(-1000, Math.min(1000, Math.round(Number(options.torque))));
  const speedLimitTurnsPerSecond = Number(options.speedlimit);
  const seconds = Number(options.seconds);
  const bus = await openBus();
  const write16 = (address, value) => bus.writeSingle(servoId, address, value & 0xffff);
  const write32 = (address, value) => bus.writeMultiple(servoId, address, split32(value));

  let stopped = false;
  const stopMotor = async () => {
    if (stopped) return;
    stopped = true;
    await write16(IHSV.TARGET_TORQUE, 0).catch(() => {});
    await write16(IHSV.CONTROL_WORD, IHSV_CONTROL.DISABLE).catch(() => {});
    console.log('Torque 0, motor disabled.');
    await bus.close();
  };
  process.once('SIGINT', async () => {
    console.log('\nCtrl-C');
    await stopMotor();
    process.exit(0);
  });

  console.log(`Torque test: ${torquePerMille} per mille of rated = ${((torquePerMille / 1000) * IHSV_RATED_TORQUE_NM).toFixed(2)} N·m,`);
  console.log(`speed limit ${speedLimitTurnsPerSecond} turns/s. Rope tied to something fixed, hands clear. Starting in 3 s...`);
  await sleep(3000);

  // CiA402: fault reset, initialise -> switch on -> enable, then torque mode and parameters, then start
  await write16(IHSV.CONTROL_WORD, 0);
  await write16(IHSV.CONTROL_WORD, IHSV_CONTROL.FAULT_RESET);
  for (const controlWord of [IHSV_CONTROL.INITIALISE, IHSV_CONTROL.SWITCH_ON, IHSV_CONTROL.ENABLE]) await write16(IHSV.CONTROL_WORD, controlWord);
  await write16(IHSV.OPERATION_MODE, IHSV_MODE.TORQUE);
  await write32(IHSV.TARGET_SPEED, Math.round(speedLimitTurnsPerSecond * 10)); // unit 0.1 rps
  await write16(IHSV.TORQUE_SLOPE, Math.round(Number(options.slope)));
  await write16(IHSV.TARGET_TORQUE, torquePerMille);
  await write16(IHSV.CONTROL_WORD, IHSV_CONTROL.START);

  const start = await readState(bus);
  console.log(`mode now ${start.mode} (4 = torque). Halfway you'll be asked to pull the rope out.\n`);
  console.log('   time  torque(‰)  speed(rpm)    position  status');
  const startTime = performance.now();
  let prompted = 0;
  try {
    while (performance.now() - startTime < seconds * 1000) {
      const elapsed = (performance.now() - startTime) / 1000;
      if (prompted === 0 && elapsed > seconds * 0.4) { console.log('  >>> NOW: pull the rope OUT by hand and hold'); prompted = 1; }
      if (prompted === 1 && elapsed > seconds * 0.7) { console.log('  >>> NOW: slowly let the rope go back'); prompted = 2; }
      const state = await readState(bus);
      console.log(`  ${elapsed.toFixed(1).padStart(5)}s ${String(state.torquePerMille).padStart(9)} ${String(state.speedRpm).padStart(11)} ${String(state.position - start.position).padStart(11)}  ${describeStatusWord(state.status)}${state.errorCode ? ` error ${state.errorCode}` : ''}`);
      if (state.status & 0x0008) {
        console.log('  FAULT: stopping.');
        break;
      }
      await sleep(200);
    }
  } finally {
    await stopMotor();
  }
}

// ---- P-parameters ---------------------------------------------------------------------------
// The manual only documents changing P-parameters with JMC's PC software over RS232. Many JMC drives also
// expose them over Modbus; this READS the usual address schemes and looks for known factory defaults.
const KNOWN_DEFAULTS = [
  { name: 'P04-05 overspeed alarm (rpm)', group: 4, index: 5, value: 6400 },
  { name: 'P04-06 forward speed limit (rpm)', group: 4, index: 6, value: 5000 },
  { name: 'P04-14 acceleration time', group: 4, index: 14, value: 500 },
  { name: 'P03-09 command pulses per turn', group: 3, index: 9, value: 4000 },
  { name: 'P01-03 rigidity (0-31)', group: 1, index: 3, value: 13 },
  { name: 'P03-15 max position deviation', group: 3, index: 15, value: 0 },
];
const ADDRESS_SCHEMES = [
  ['group*0x100 + index', (group, index) => group * 0x100 + index],
  ['0x2000 + group*0x100 + index', (group, index) => 0x2000 + group * 0x100 + index],
  ['group*100 + index', (group, index) => group * 100 + index],
  ['0x2000 + group*100 + index', (group, index) => 0x2000 + group * 100 + index],
  ['0x1000 + group*0x100 + index', (group, index) => 0x1000 + group * 0x100 + index],
  ['0x3000 + group*0x100 + index', (group, index) => 0x3000 + group * 0x100 + index],
  ['0x4000 + group*0x100 + index', (group, index) => 0x4000 + group * 0x100 + index],
  ['0x5000 + group*0x100 + index', (group, index) => 0x5000 + group * 0x100 + index],
];
const hex = (value) => '0x' + value.toString(16).padStart(4, '0');

async function findParams() {
  const bus = await openBus(Number(options.baud), true);
  try {
    for (const [schemeName, addressOf] of ADDRESS_SCHEMES) {
      let matches = 0;
      const lines = [];
      for (const known of KNOWN_DEFAULTS) {
        const address = addressOf(known.group, known.index);
        let text;
        try {
          const value = (await bus.readHolding(servoId, address, 1))[0];
          const isMatch = value === known.value || value === known.value * 10;
          if (isMatch) matches++;
          text = `${value}${isMatch ? '  <- matches factory default' : ''}`;
        } catch (error) {
          text = error.constructor.name === 'ModbusException' ? '(no such register)' : `(${error.message})`;
        }
        lines.push(`    ${hex(address)}  ${known.name.padEnd(36)} ${text}`);
      }
      console.log(`${schemeName}: ${matches} match(es)`);
      lines.forEach((line) => console.log(line));
    }
    console.log('\nPaste this output back. Nothing was written.');
  } finally {
    await bus.close();
  }
}

async function param() {
  const address = Number(argument);
  if (!Number.isInteger(address)) throw new Error('Usage: param <address> [value]   e.g. param 0x0103   or   param 0x0103 20');
  const bus = await openBus();
  try {
    if (argument2 !== undefined) {
      await bus.writeSingle(servoId, address, Number(argument2) & 0xffff);
      console.log(`wrote ${hex(address)} = ${Number(argument2)}`);
    }
    console.log(`${hex(address)} = ${(await bus.readHolding(servoId, address, 1))[0]}`);
  } finally {
    await bus.close();
  }
}

/** Motor disabled; prints the position so you can turn the shaft one turn by hand and read counts per turn. */
async function watch() {
  const bus = await openBus();
  await bus.writeSingle(servoId, IHSV.CONTROL_WORD, IHSV_CONTROL.DISABLE);
  console.log('Motor disabled. Turn the shaft exactly one turn by hand; the change in position = counts per turn. Ctrl-C to stop.');
  const start = await readState(bus);
  process.once('SIGINT', async () => {
    await bus.close();
    process.exit(0);
  });
  for (;;) {
    const state = await readState(bus);
    process.stdout.write(`\rposition ${String(state.position).padStart(10)}   change ${String(state.position - start.position).padStart(8)}   `);
    await sleep(200);
  }
}

/**
 * Position streaming test, same idea as bin/cli.js sine: every tick, aim `lookahead` ticks ahead at the
 * average speed over that window. Per tick and motor: ONE 9-register frame (control word with bit4 low,
 * mode, speed, acc, dec, quick-stop dec, target), then ONE control-word write with bit4 high = take this
 * target now (bit5 = change immediately, don't finish the previous move).
 */
async function sine() {
  const amplitudeTurns = Number(options.amp), frequencyHz = Number(options.freq), rateHz = Number(options.rate);
  const lookaheadTicks = Number(options.lookahead), countsPerTurn = Number(options.countsperturn), seconds = Number(options.seconds);
  const acceleration = Math.round(Number(options.acc));
  const tickSeconds = 1 / rateHz, horizonSeconds = lookaheadTicks * tickSeconds;
  const CONTROL_ENABLE_IMMEDIATE = IHSV_CONTROL.ENABLE | 0x0020; // bit5: new target replaces the running move
  const CONTROL_TAKE_TARGET = CONTROL_ENABLE_IMMEDIATE | 0x0010; //  bit4 rising edge: take the new target
  const bus = await openBus();
  const write16 = (address, value) => bus.writeSingle(servoId, address, value & 0xffff);

  let stopped = false;
  const stopMotor = async () => {
    if (stopped) return;
    stopped = true;
    await sleep(500); // let the last move finish
    await write16(IHSV.CONTROL_WORD, IHSV_CONTROL.DISABLE).catch(() => {});
    console.log('Motor disabled.', bus.stats);
    await bus.close();
  };
  process.once('SIGINT', async () => {
    console.log('\nCtrl-C');
    await stopMotor();
    process.exit(0);
  });

  await write16(IHSV.CONTROL_WORD, 0);
  await write16(IHSV.CONTROL_WORD, IHSV_CONTROL.FAULT_RESET);
  for (const controlWord of [IHSV_CONTROL.INITIALISE, IHSV_CONTROL.SWITCH_ON, IHSV_CONTROL.ENABLE]) await write16(IHSV.CONTROL_WORD, controlWord);
  await write16(IHSV.OPERATION_MODE, IHSV_MODE.POSITION);
  const startPosition = (await readState(bus)).position;
  console.log(`Sine ±${amplitudeTurns} turns at ${frequencyHz} Hz, ${rateHz} updates/s, look-ahead ${lookaheadTicks} ticks, ${countsPerTurn} counts/turn. No rope, shaft free to turn.`);
  console.log('   time   target   actual      lag  speed-cmd(0.1rps)  torque(‰)  bus-ms  status');

  const turnsAt = (t) => amplitudeTurns * Math.sin(2 * Math.PI * frequencyHz * t);
  const startTime = performance.now();
  let nextTick = startTime;
  try {
    for (let tick = 0; (performance.now() - startTime) / 1000 < seconds; tick++) {
      const t = (performance.now() - startTime) / 1000;
      const tickStart = performance.now();
      const nowTurns = turnsAt(t), aheadTurns = turnsAt(t + horizonSeconds);
      const targetCounts = startPosition + Math.round(aheadTurns * countsPerTurn);
      // speed register is in 0.1 turns/s: round UP so the motor never lags, minimum 1 (= 6 rpm)
      const speedTenthTurnsPerSecond = Math.max(1, Math.ceil((Math.abs(aheadTurns - nowTurns) / horizonSeconds) * 10));
      // --oneframe: write the control word with bit4 already high in the same frame. Only works if the drive
      // takes a new target on every write with bit4 set (not just on a 0->1 edge): the log shows whether it follows.
      await bus.writeMultiple(servoId, IHSV.CONTROL_WORD, [
        options.oneframe ? CONTROL_TAKE_TARGET : CONTROL_ENABLE_IMMEDIATE, IHSV_MODE.POSITION, ...split32(speedTenthTurnsPerSecond), acceleration, acceleration, acceleration, ...split32(targetCounts),
      ], { paced: options.paced });
      if (!options.oneframe) await bus.writeSingle(servoId, IHSV.CONTROL_WORD, CONTROL_TAKE_TARGET, { paced: options.paced });
      const busMs = performance.now() - tickStart;
      if (tick % 2 === 0) {
        const state = await readState(bus);
        const actualTurns = (state.position - startPosition) / countsPerTurn;
        console.log(`  ${t.toFixed(1).padStart(5)}s ${nowTurns.toFixed(3).padStart(7)} ${actualTurns.toFixed(3).padStart(8)} ${(nowTurns - actualTurns).toFixed(3).padStart(8)} ${String(speedTenthTurnsPerSecond).padStart(18)} ${String(state.torquePerMille).padStart(10)} ${busMs.toFixed(0).padStart(7)}  ${describeStatusWord(state.status)}`);
        if (state.status & 0x0008) {
          console.log('  FAULT: stopping.');
          break;
        }
      }
      nextTick += tickSeconds * 1000;
      const wait = nextTick - performance.now();
      if (wait > 0) await sleep(wait);
      else nextTick = performance.now();
    }
  } finally {
    await stopMotor();
  }
}

// Factory defaults that identify parameter groups (from the manual's parameter table).
// Values with one decimal in the manual (e.g. 48.0) are probably stored x10.
const FINGERPRINTS = [
  [6400, 'P04-05 overspeed alarm 6400 rpm'],
  [5000, 'P04-06 forward speed limit 5000 rpm'],
  [60536, 'P04-07 reverse speed limit -5000 rpm'],
  [500, 'P04-14/15 accel/decel time 500'],
  [4000, 'P03-09/10/11 pulses per turn / gear 4000'],
  [13, 'P01-03 rigidity 13'],
  [480, 'P02-00 position gain 48.0'],
  [570, 'P02-01 position gain 57.0'],
  [270, 'P02-10/13 speed gain 27.0'],
  [2000, 'P05-10/11 torque limit 200.0 %'],
];

/** Read every address once (read-only), one at a time, and record what answers. Resumable. */
async function scan() {
  const firstAddress = Number(options.from), lastAddress = Number(options.to), width = Number(options.width);
  options.out ??= width === 2 ? 'servo-scan-32bit.jsonl' : 'servo-scan.jsonl';
  const done = new Map(); // address -> value | null
  if (existsSync(options.out)) {
    for (const line of readFileSync(options.out, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      done.set(entry.address, entry.value);
    }
    console.log(`Resuming: ${done.size} addresses already in ${options.out}`);
  }
  let nothingLeft = true;
  for (let address = firstAddress; address <= lastAddress && nothingLeft; address++) if (!done.has(address)) nothingLeft = false;
  if (nothingLeft) return summarizeScan(done); // everything already scanned: just show the summary
  const bus = new ModbusRtuBus({ path: options.port, baudRate: Number(options.baud), parity: options.parity, timeoutMs: 60, retries: 0 });
  await bus.open();
  process.once('SIGINT', async () => {
    console.log(`\nStopped. Progress is saved in ${options.out}; run the same command again to continue.`);
    process.exit(0);
  });
  const startTime = performance.now();
  let scannedNow = 0, silentInARow = 0;
  try {
    for (let address = firstAddress; address <= lastAddress; address++) {
      if (done.has(address)) continue;
      let value = null;
      try {
        const words = await bus.readHolding(servoId, address, width);
        value = width === 2 ? toInt32(words) : words[0];
        silentInARow = 0;
      } catch (error) {
        // exception = no such register (normal); timeout = no answer at all
        silentInARow = error.constructor.name === 'ModbusTimeout' ? silentInARow + 1 : 0;
        if (silentInARow >= 20) throw new Error('The servo stopped answering (20 timeouts in a row). Check power and cable, then run again to resume.');
      }
      done.set(address, value);
      appendFileSync(options.out, JSON.stringify({ address, value }) + '\n');
      scannedNow++;
      if (value !== null) console.log(`  ${hex(address)} = ${String(value).padStart(5)}  (signed ${toInt16(value)})${FINGERPRINTS.find(([v]) => v === value) ? '   <- ' + FINGERPRINTS.find(([v]) => v === value)[1] + '?' : ''}`);
      if (scannedNow % 256 === 0) {
        const msPerAddress = (performance.now() - startTime) / scannedNow;
        const remaining = lastAddress - address;
        process.stderr.write(`  ... at ${hex(address)}, about ${Math.ceil((remaining * msPerAddress) / 60000)} min to go\n`);
      }
    }
  } finally {
    await bus.close();
  }
  summarizeScan(done);
}

function summarizeScan(done) {
  const readable = [...done.entries()].filter(([, value]) => value !== null).sort((a, b) => a[0] - b[0]);
  console.log(`\n${readable.length} readable addresses. Fingerprint hits:`);
  for (const [address, value] of readable) {
    const fingerprint = FINGERPRINTS.find(([v]) => v === value);
    if (fingerprint) console.log(`  ${hex(address)} = ${value}  ${fingerprint[1]}?`);
  }
  // groups of readable addresses close together = likely a parameter block
  console.log('Readable address blocks:');
  let blockStart = null, previous = null;
  for (const [address] of [...readable, [Infinity]]) {
    if (blockStart !== null && address - previous > 4) {
      console.log(`  ${hex(blockStart)}..${hex(previous)} (${readable.filter(([a]) => a >= blockStart && a <= previous).length} registers)`);
      blockStart = null;
    }
    if (address === Infinity) break;
    if (blockStart === null) blockStart = address;
    previous = address;
  }
  console.log(`Paste this summary (and ${options.out} if you like) back.`);
}

const commands = { info, probe, torquetest: torqueTest, findparams: findParams, param, watch, sine, scan };
if (!commands[command]) {
  console.log('Usage: node servo/servo-cli.js info | probe | torquetest | findparams | param <addr> [value] | watch | sine   (see the top of this file)');
} else {
  commands[command]().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
