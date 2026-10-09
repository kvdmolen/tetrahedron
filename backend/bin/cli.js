#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ModbusRtuBus, IclRsMotor, MotorGroup, MockPort, BAUD_CODES, REG, PR_CMD } from '../src/index.js';
import { listSerialPorts, findRs485Port, DEFAULT_RS485_PORT, DEFAULT_BAUD_RATE } from '../src/serialPorts.js';

const HELP = `iCL-RS test tool
Usage: node bin/cli.js <command> [options]

Commands
  ports                 list serial ports
  scan                  look for drives on IDs 1..31 (at --baud)
  probe                 try ID 1 at every baud/parity combo and show raw bytes (use when scan finds nothing)
  info                  voltage, alarm, position, current setting of --ids
  bench                 round-trip timing (tells you if 10 Hz x N motors is feasible)
  current <amps>        set peak current (add --save to store in EEPROM)
  zero                  declare current position as 0
  move <revs>           absolute move, e.g. 'move 1.5' (add --rpm 60)
  sine                  all --ids follow a phase-shifted sine (--amp 1 --freq 0.2 --rate 10 --seconds 20
                        --lookahead 3 [ticks] --acc 100 [ms per 1000 rpm] --ramp fixed|adaptive)
  estop                 broadcast quick-stop to every drive
  params                show the torque/tension-related drive parameters
  param <addr> [value]  read (or write) one register, e.g. 'param 0x000B' or 'param 0x000B 20000'
  tensiontest           can this motor hold a rope at constant tension? (see --current --pull --seconds)
                        options: --current 0.8 [A] --pull 0.15 [turns beyond reach] --kp N --maxerr N --standby %
  interrupttest         does a new command take over a running move? (motor turns up to ~3 rev forward, returns to 0 between tests)

Options
  --port <path>   default /dev/cu.usbserial-A50285BI             --baud <n>   default 115200
  --ids 1,2,3     drive IDs (default 1)                        --mock       use simulated drives
`;

// parseArgs reads '-0.3' as an option name; turn '--pull -0.3' into '--pull=-0.3' and pass
// negative positionals (e.g. 'move -1.5') after '--', so negative numbers work everywhere.
const isNegativeNumber = (token) => /^-(\d+\.?\d*|\.\d+)$/.test(token);
const cliArgs = [], negativePositionals = [];
for (const token of process.argv.slice(2)) {
  const previous = cliArgs[cliArgs.length - 1];
  if (isNegativeNumber(token) && previous?.startsWith('--') && !previous.includes('=')) cliArgs[cliArgs.length - 1] = `${previous}=${token}`;
  else if (isNegativeNumber(token)) negativePositionals.push(token);
  else cliArgs.push(token);
}
if (negativePositionals.length) cliArgs.push('--', ...negativePositionals);

const { values: o, positionals: [cmd, arg, arg2] } = parseArgs({
  args: cliArgs,
  allowPositionals: true,
  options: {
    port: { type: 'string', default: DEFAULT_RS485_PORT }, baud: { type: 'string', default: String(DEFAULT_BAUD_RATE) }, ids: { type: 'string', default: '1' },
    mock: { type: 'boolean', default: false }, rpm: { type: 'string', default: '60' }, save: { type: 'boolean', default: false },
    amp: { type: 'string', default: '1' }, freq: { type: 'string', default: '0.2' }, rate: { type: 'string', default: '10' },
    seconds: { type: 'string', default: '20' }, current: { type: 'string', default: '0.8' }, pull: { type: 'string', default: '0.15' },
    kp: { type: 'string' }, maxerr: { type: 'string' }, standby: { type: 'string' }, lookahead: { type: 'string', default: '3' }, acc: { type: 'string', default: '100' }, ramp: { type: 'string', default: 'fixed' }, maxrpm: { type: 'string', default: '600' },
  },
});

const ids = o.ids.split(',').map(Number);
const f = (x) => Number(o[x]);

const listPorts = listSerialPorts;
const findPort = () => findRs485Port(o.port);

async function openBus() {
  if (o.mock) {
    const bus = new ModbusRtuBus({ port: new MockPort({ ids: [...ids, 1] }), baudRate: f('baud') });
    await bus.open();
    console.log('(mock mode: simulated drives)');
    return bus;
  }
  const path = await findPort();
  console.log(`Port ${path} @ ${o.baud} 8N1`);
  const bus = new ModbusRtuBus({ path, baudRate: f('baud') });
  await bus.open();
  return bus;
}

async function makeMotors(bus) {
  const motors = ids.map((id) => new IclRsMotor(bus, id));
  for (const m of motors) await m.syncPulsesPerRev();
  return motors;
}

async function probe() {
  const path = await findPort();
  const id = ids[0];
  console.log(`Probing ID ${id} on ${path}. Each line = one baud/parity try. Watch the TX LED on the converter.\n`);
  for (const parity of ['none', 'even', 'odd']) {
    for (const baud of [38400, 9600, 19200, 115200, 57600, 4800, 2400]) {
      const bus = new ModbusRtuBus({ path, baudRate: baud, parity, timeoutMs: 150, retries: 0 });
      await bus.open();
      const raw = [];
      bus.port.on('data', (d) => raw.push(d));
      let result;
      try {
        const v = (await bus.readHolding(id, REG.BUS_VOLTAGE, 1))[0] / 10;
        result = `*** ANSWER! bus voltage ${v} V ***`;
      } catch (e) {
        const bytes = Buffer.concat(raw);
        result = bytes.length ? `bytes received but invalid (${e.constructor.name}): ${bytes.toString('hex')}` : 'silence';
      }
      console.log(`${String(baud).padStart(6)} baud, parity ${parity.padEnd(4)}: ${result}`);
      await bus.close();
      if (result.startsWith('***')) return console.log(`\nUse: --baud ${baud}${parity === 'none' ? '' : ' (parity ' + parity + ' — CLI needs a --parity option, tell me)'}`);
    }
  }
  console.log('\nNo valid answer at any setting. Raw bytes = wiring/polarity is probably OK but settings are off; silence everywhere = wiring, polarity, power or converter.');
}

// Does the drive accept a new command while a path is running? Each variant starts a move,
// changes it after 1 s, and logs the drive's COMMANDED (profile) position and speed every 250 ms.
// Profile position is what the drive's planner is doing, independent of encoder units.
async function interruptTest(bus, m) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const P = m.pulsesPerRev, rev = (p) => (p / P).toFixed(2);
  const hilo = (v) => [(v >> 16) & 0xffff, v & 0xffff];
  const path = (mode, revs, rpm) => [mode, ...hilo(Math.round(revs * P)), rpm, 100, 100, 0];
  const pr0 = (mode, revs, rpm) => bus.writeMultiple(m.id, REG.PR0_BASE, [...path(mode, revs, rpm), 0x10]);
  const stopAndHome = async () => {
    await m.quickStop(); await sleep(300);
    await pr0(0x01, 0, 120);
    for (let i = 0; i < 100 && Math.abs((await m.positions()).profile) > 10; i++) await sleep(100);
    await sleep(300);
  };
  const variants = [
    ['A  PR0 pos, INS bit (0x11), new target 0.5 rev', () => pr0(0x11, 3, 60), () => pr0(0x11, 0.5, 60)],
    ['A2 PR0 pos, no INS (0x01), new target 0.5 rev', () => pr0(0x01, 3, 60), () => pr0(0x01, 0.5, 60)],
    ['D  PR0 pos, INS+overlap (0x31), new target 0.5 rev', () => pr0(0x31, 3, 60), () => pr0(0x31, 0.5, 60)],
    ['B  PR1 + trigger 0x11, new target 0.5 rev', () => pr0(0x11, 3, 60), async () => {
      await bus.writeMultiple(m.id, REG.PR0_BASE + 8, [...path(0x11, 0.5, 60), 0]); await bus.writeSingle(m.id, REG.PR_CONTROL, 0x11); }],
    ['F  PR0 pos, rewrite position regs only (no trigger) -> 0.5 rev', () => pr0(0x11, 3, 60), () => bus.writeMultiple(m.id, REG.PR0_BASE + 1, hilo(Math.round(0.5 * P)))],
    ['V1 PR0 velocity 30 rpm, then write speed reg only -> 60 rpm', () => pr0(0x02, 0, 30), () => bus.writeSingle(m.id, REG.PR0_BASE + 3, 60)],
    ['V2 PR0 velocity 30 rpm, then full PR0 velocity frame -> 60 rpm', () => pr0(0x02, 0, 30), () => pr0(0x02, 0, 60)],
  ];
  const r0 = await m.positions();
  console.log(`pulses/rev ${P}. Before zero: profile ${r0.profile} feedback ${r0.feedback} (raw pulses)`);
  await m.setZero(); await sleep(200);
  const r1 = await m.positions();
  console.log(`After zero:  profile ${r1.profile} feedback ${r1.feedback}`);
  for (const [label, start, change] of variants) {
    console.log(`\n${label}`);
    await start();
    const log = [];
    const t0 = performance.now();
    let changed = false;
    while (performance.now() - t0 < 3000) {
      if (!changed && performance.now() - t0 > 1000) { await change(); changed = true; log.push('  >> change sent'); }
      const p = await m.positions();
      log.push({ t: (performance.now() - t0) / 1000, prof: p.profile, fb: p.feedback });
      await sleep(250);
    }
    let prev = null;
    for (const e of log) {
      if (typeof e === 'string') { console.log(e); continue; }
      const rpm = prev ? (((e.prof - prev.prof) / P) * 60) / (e.t - prev.t) : 0;
      console.log(`  t=${e.t.toFixed(2)}s  commanded ${rev(e.prof).padStart(6)} rev  ${rpm.toFixed(0).padStart(4)} rpm   encoder ${e.fb}`);
      prev = e;
    }
    await stopAndHome();
  }
  console.log('\nDone. Paste all of this back.');
}

// ---- tension / torque experiments -----------------------------------------------------------

const TENSION_PARAMS = [
  { address: 0x0003, name: 'Pr0.01 control mode (0 = open loop, 2 = closed loop)' },
  { address: 0x000b, name: 'Pr0.05 allowed max following error' },
  { address: 0x0051, name: 'Pr1.00 position loop Kp' },
  { address: 0x0053, name: 'Pr1.01 velocity loop Ki' },
  { address: 0x0055, name: 'Pr1.02 velocity loop Kp' },
  { address: 0x00a1, name: 'Pr2.00 command filter (0.1 ms)' },
  { address: 0x016d, name: 'Pr4.22 alarm detection bits (bit4 = locked shaft)' },
  { address: 0x0191, name: 'Pr5.00 peak current (0.1 A)' },
  { address: 0x0193, name: 'Pr5.01 closed-loop holding current (%)' },
  { address: 0x01d1, name: 'Pr5.32 time until standby (ms)' },
  { address: 0x01d3, name: 'Pr5.33 standby current (%)' },
  { address: 0x6013, name: 'Pr8.19 torque homing hold time (ms)' },
  { address: 0x6014, name: 'Pr8.20 torque homing force (%)' },
];
const ADDRESS = { maxFollowingError: 0x000b, positionKp: 0x0051, peakCurrent: 0x0191, standbyPercent: 0x01d3 };
const hex = (value) => '0x' + value.toString(16).padStart(4, '0');

async function showTensionParams(motor) {
  for (const { address, name } of TENSION_PARAMS) {
    try {
      console.log(`  ${hex(address)}  ${String(await motor.readReg(address)).padStart(6)}   ${name}`);
    } catch (error) {
      console.log(`  ${hex(address)}  ${'?'.padStart(6)}   ${name}  (${error.message})`);
    }
  }
}

/**
 * Tension experiment. The motor is asked to wind `pull` turns further than the rope allows, with only
 * `current` amps, so it should stall and keep pulling. Logs lag, current-related state and alarms
 * every 200 ms; asks you to pull the rope out by hand halfway, then let go.
 * Every changed parameter is restored at the end (also on Ctrl-C).
 */
async function tensionTest(bus, motor) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pullTurns = f('pull'), currentAmps = f('current'), seconds = f('seconds');
  const pulsesPerTurn = motor.pulsesPerRev;

  // what we change, and what it was
  const changes = [[ADDRESS.peakCurrent, Math.round(currentAmps * 10)]];
  if (o.kp !== undefined) changes.push([ADDRESS.positionKp, Number(o.kp)]);
  if (o.maxerr !== undefined) changes.push([ADDRESS.maxFollowingError, Number(o.maxerr)]);
  if (o.standby !== undefined) changes.push([ADDRESS.standbyPercent, Number(o.standby)]);
  const originals = [];
  for (const [address] of changes) originals.push([address, await motor.readReg(address)]);

  let restored = false;
  const relaxAndRestore = async () => {
    if (restored) return;
    restored = true;
    try {
      const { profile, feedback } = await motor.positions();
      await motor.moveToPulses(feedback - profile, { relative: true, rpm: 30 }); // target = where the shaft is: stop pulling
      await sleep(300);
    } catch (error) {
      console.log(`(could not relax: ${error.message})`);
    }
    for (const [address, value] of originals) await bus.writeSingle(motor.id, address, value).catch(() => {});
    console.log(`Restored: ${originals.map(([address, value]) => `${hex(address)}=${value}`).join(', ')}`);
  };
  process.once('SIGINT', async () => {
    console.log('\nCtrl-C: relaxing and restoring...');
    await relaxAndRestore();
    process.exit(0);
  });

  console.log('Current settings:');
  await showTensionParams(motor);
  console.log(`
Setup: rope (or a string) wound a few turns on the pulley, other end tied to something FIXED
(or hold the pulley firmly). A luggage scale in the rope shows the actual tension.
The motor will try to wind ${pullTurns} turns further than possible, with only ${currentAmps} A.
Halfway it asks you to pull the rope out by hand: does it give way smoothly, and does it alarm?
Starting in 3 s (Ctrl-C to abort)...`);
  await sleep(3000);

  for (const [address, value] of changes) await bus.writeSingle(motor.id, address, value);
  console.log(`Set: ${changes.map(([address, value]) => `${hex(address)}=${value}`).join(', ')}\n`);

  const start = await motor.positions();
  await motor.moveToPulses(Math.round(pullTurns * pulsesPerTurn), { relative: true, rpm: f('rpm') });
  const startTime = performance.now();
  const turns = (pulses) => (pulses / pulsesPerTurn).toFixed(3).padStart(7);
  const pullPrompt = seconds * 0.4, releasePrompt = seconds * 0.7;
  let prompted = 0;
  console.log('   time  commanded   actual      lag  lag-register  status  alarm   (turns, relative to start)');
  while (performance.now() - startTime < seconds * 1000) {
    const elapsed = (performance.now() - startTime) / 1000;
    if (prompted === 0 && elapsed >= pullPrompt) { console.log('  >>> NOW: pull the rope OUT by hand a few cm and hold it there'); prompted = 1; }
    if (prompted === 1 && elapsed >= releasePrompt) { console.log('  >>> NOW: slowly let the rope go back'); prompted = 2; }
    const position = await motor.positions();
    const status = await motor.status();
    const alarm = await motor.alarm();
    const commanded = position.profile - start.profile, actual = position.feedback - start.feedback;
    console.log(`  ${elapsed.toFixed(1).padStart(5)}s ${turns(commanded)}  ${turns(actual)}  ${turns(commanded - actual)}  ${String(position.followingError).padStart(12)}  ${hex(status.raw)}  ${alarm.mask ? alarm.text : '-'}`);
    if (alarm.mask) {
      console.log(`  ALARM: ${alarm.text}. Trying to clear it...`);
      await motor.clearAlarm().catch(() => {});
      await sleep(300);
      console.log(`  alarm now: ${(await motor.alarm()).text} (if the red LED still blinks: power-cycle)`);
      break;
    }
    await sleep(200);
  }
  await relaxAndRestore();
}

async function main() {
  if (!cmd || cmd === 'help') return console.log(HELP);
  if (cmd === 'ports') {
    for (const p of await listPorts()) console.log(p.path, p.manufacturer ?? '', p.vendorId ?? '', p.productId ?? '');
    return;
  }
  if (cmd === 'probe') return probe();
  const bus = await openBus();
  try {
    if (cmd === 'estop') {
      await bus.broadcastWrite(REG.PR_CONTROL, PR_CMD.QUICK_STOP);
      return console.log('Quick-stop broadcast sent.');
    }
    if (cmd === 'scan') {
      bus.retries = 0; bus.timeoutMs = 100;
      for (let id = 1; id <= 31; id++) {
        try {
          const v = (await bus.readHolding(id, REG.BUS_VOLTAGE, 1))[0] / 10;
          console.log(`ID ${id}: found, bus ${v} V`);
        } catch { /* nobody home */ }
      }
      return console.log('Scan done.');
    }

    const motors = await makeMotors(bus);
    if (cmd === 'interrupttest') return await interruptTest(bus, motors[0]);
    if (cmd === 'tensiontest') return await tensionTest(bus, motors[0]);
    if (cmd === 'params') return await showTensionParams(motors[0]);
    if (cmd === 'param') {
      const address = Number(arg);
      const value = arg2;
      if (!Number.isInteger(address)) throw new Error('Usage: param <address> [value], e.g. param 0x000B 20000');
      if (value !== undefined) {
        await bus.writeSingle(motors[0].id, address, Number(value));
        console.log(`wrote ${hex(address)} = ${Number(value)}${o.save ? ' (saving to EEPROM)' : ' (until power-off; add --save to keep)'}`);
        if (o.save) await motors[0].saveToEeprom();
      }
      return console.log(`${hex(address)} = ${await motors[0].readReg(address)}`);
    }

    if (cmd === 'info') {
      for (const m of motors) {
        const [v, a, st, pos, cur, baud] = await Promise.all([m.busVoltage(), m.alarm(), m.status(), m.positions(), m.peakCurrent(), m.readReg(REG.RS485_BAUD)]);
        console.log(`\n[${m.name}] bus ${v} V | peak current ${cur} A | pulses/rev ${m.pulsesPerRev} | Pr5.22 baud = ${BAUD_CODES[baud] ?? baud}`);
        console.log(`  alarm: ${a.text} | enabled=${st.enabled} fault=${st.fault} running=${st.running}`);
        console.log(`  position (raw, the drive's zero isn't visible here): encoder ${pos.encoderCounts} counts = ${(pos.encoderCounts / 65536).toFixed(3)} rev, commanded ${pos.profileRaw} pulses`);
      }
    } else if (cmd === 'bench') {
      const m = motors[0], n = 200, times = [];
      for (let i = 0; i < n; i++) { const t = performance.now(); await m.positions(); times.push(performance.now() - t); }
      times.sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b) / n;
      console.log(`${n} reads: min ${times[0].toFixed(1)} ms  median ${times[n >> 1].toFixed(1)}  p95 ${times[Math.floor(n * 0.95)].toFixed(1)}  max ${times[n - 1].toFixed(1)}  avg ${avg.toFixed(1)}`);
      console.log(`Estimated bus time for 12 motors per tick: ~${(avg * 12).toFixed(0)} ms (budget at 10 Hz: 100 ms). Stats:`, bus.stats);
    } else if (cmd === 'current') {
      for (const m of motors) { await m.setPeakCurrent(Number(arg)); if (o.save) await m.saveToEeprom(); console.log(`${m.name}: peak current ${await m.peakCurrent()} A${o.save ? ' (saved)' : ''}`); }
    } else if (cmd === 'zero') {
      for (const m of motors) { await m.setZero(); console.log(`${m.name}: zeroed`); }
    } else if (cmd === 'move') {
      const revs = Number(arg);
      if (!Number.isFinite(revs)) throw new Error('Usage: move <revs>');
      // Targets are relative to the drive's zero (set with 'zero'), but the position registers
      // aren't, so watch the move by how far it went from where it started.
      const m0 = motors[0], start = (await m0.positions()).feedback;
      for (const m of motors) await m.moveToRev(revs, { rpm: f('rpm') });
      let last = NaN;
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const p = await m0.positions();
        process.stdout.write(`\rmoved ${((p.feedback - start) / m0.pulsesPerRev).toFixed(3)} rev   `);
        if (i > 3 && p.profile === last) break;
        last = p.profile;
      }
      console.log();
    } else if (cmd === 'sine') {
      const group = new MotorGroup(bus, motors, { rateHz: f('rate'), maxRpm: f('maxrpm'), lookahead: f('lookahead'), accMs: f('acc'), decMs: f('acc'), ramp: o.ramp });
      group.on('overrun', ({ tick, ms }) => console.warn(`tick ${tick} took ${ms.toFixed(0)} ms (> period)`));
      group.on('motorError', ({ motor, error }) => console.warn(`${motor.name}: ${error.message}`));
      group.on('alarm', ({ motor, text }) => console.error(`ALARM ${motor.name}: ${text}`));
      group.on('fatal', ({ error }) => console.error('FATAL:', error.message));
      process.on('SIGINT', async () => { console.log('\nStopping...'); await group.emergencyStop(); setTimeout(() => process.exit(0), 200); });
      const n = motors.length, amp = f('amp'), w = 2 * Math.PI * f('freq');
      console.log(`Sine: ${n} motor(s), amplitude ±${amp} rev, ${f('freq')} Hz, ${f('rate')} Hz updates. Ctrl-C = quick stop.`);
      await group.start((t, i) => amp * Math.sin(w * t + (i * 2 * Math.PI) / n), { seconds: f('seconds') });
      await Promise.all(motors.map((m) => m.moveToRev(0, { rpm: 60 }))); // glide home
      console.log('Done, returning to 0.', bus.stats);
    } else console.log(HELP);
  } finally {
    await bus.close();
  }
}

main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
