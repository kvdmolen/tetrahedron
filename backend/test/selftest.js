import assert from 'node:assert/strict';
import { crc16, appendCrc } from '../src/crc16.js';
import { ModbusRtuBus, IclRsMotor, MotorGroup, MockPort } from '../src/index.js';

const hex = (b) => Buffer.from(b).toString('hex');

// 1. CRC against frames printed in the manual
for (const [body, crc] of [
  ['010301910001', 'd41b'],
  ['010662000041', '5642'],
  ['010662010003', '87b3'],
  ['010660020040', '37fa'],
  ['010660020010', '37c6'],
]) {
  assert.equal(hex(appendCrc(Buffer.from(body, 'hex'))).slice(-4), crc, `CRC for ${body}`);
}
console.log('crc ok');

// 2. Bus + motor against the simulator
const port = new MockPort({ ids: Array.from({ length: 12 }, (_, i) => i + 1), latencyMs: 3 });
const bus = new ModbusRtuBus({ port, baudRate: 115200 });
await bus.open();
const m1 = new IclRsMotor(bus, 1);
assert.equal(await m1.syncPulsesPerRev(), 10000);
assert.equal(await m1.busVoltage(), 48);
await m1.moveToRev(-1.5, { rpm: 600 });
await new Promise((r) => setTimeout(r, 400));
assert.equal((await m1.positions()).feedback, -15000);
await m1.setZero(); // registers keep raw values; positions() must report relative to here
await m1.moveToRev(0.5, { rpm: 600 });
await new Promise((r) => setTimeout(r, 200));
await m1.moveToRev(0.25, { rpm: 600 }); // must replace the running move
await new Promise((r) => setTimeout(r, 400));
const p1 = await m1.positions();
assert.equal(p1.feedback, 2500);
assert.equal(p1.profileRaw, -15000 + 2500);
console.log('single motor ok');

// 3. 12 motors, 10 Hz, 3 s
const motors = Array.from({ length: 12 }, (_, i) => new IclRsMotor(bus, i + 1));
const group = new MotorGroup(bus, motors, { rateHz: 10 });
let overruns = 0, ticks = 0, worst = 0;
group.on('overrun', () => overruns++);
group.on('tick', ({ ms }) => { ticks++; worst = Math.max(worst, ms); });
group.on('motorError', ({ error }) => assert.fail(error));
await group.start((t, i) => 2 * Math.sin(2 * Math.PI * 0.25 * t + i), { seconds: 3 });
const p = await motors[5].positions();
console.log(`12 motors: ${ticks} ticks, ${overruns} overruns, worst tick ${worst.toFixed(0)} ms, motor6 at ${(p.feedback / 10000).toFixed(2)} rev`);
assert.equal(overruns, 0);
assert.ok(ticks >= 29);
console.log('all ok', bus.stats);
await bus.close();
