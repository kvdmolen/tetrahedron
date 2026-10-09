#!/usr/bin/env node
// Test tool for the JMC iHSV57 servo over the same RS485 converter (separate from bin/cli.js).
//
//   node servo/servo-cli.js info                    status, mode, position, speed, torque
//   node servo/servo-cli.js probe                   look for the servo at every baud rate (ID --id)
//   node servo/servo-cli.js torquetest --torque 300 --speedlimit 0.5 --seconds 20
//        real torque mode: pulls with 300 per mille (30 %) of rated torque, never faster than 0.5 turns/s.
//        Negative --torque pulls the other way. Ctrl-C (or the end) sets torque 0 and disables the motor.
import { parseArgs } from 'node:util';
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
const { values: options, positionals: [command] } = parseArgs({
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
  },
});
const servoId = Number(options.id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toInt32 = ([high, low]) => ((high << 16) | low) | 0;
const toInt16 = (value) => (value << 16) >> 16;
const split32 = (value) => [(value >> 16) & 0xffff, value & 0xffff];

async function openBus(baudRate = Number(options.baud), quick = false) {
  const bus = new ModbusRtuBus({ path: options.port, baudRate, ...(quick ? { timeoutMs: 150, retries: 0 } : {}) });
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

const commands = { info, probe, torquetest: torqueTest };
if (!commands[command]) {
  console.log('Usage: node servo/servo-cli.js info | probe | torquetest [--torque 200] [--speedlimit 0.5] [--seconds 20] [--id 1] [--port ...] [--baud 115200]');
} else {
  commands[command]().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
