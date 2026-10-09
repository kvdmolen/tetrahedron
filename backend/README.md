# Tetra: rope sculpture controller

```
npm install
npm run start:mock      # simulated motors      -> open http://localhost:4000
npm start               # real motors (press Connect in the screen)
npm test                # motor protocol, shared model vs. original frontend, end-to-end with simulated motors
```

## How it fits together
```
screen (frontend/index.html)  --WebSocket-->  backend/src/server.js
   sliders -> {type:'setInputs'}                SculptureController
   draws the 'state' it receives (25/s)           inputs -> shared/shapeControls.js -> 4 node targets
                                                  shared/RopeModel.js, 100 Hz -> 16 free rope lengths
                                                  RopeDrive: length -> pulley turns (shared/winding.js)
                                                  TrajectoryBuffer -> MotorGroup plays it motorDelayMs later
```
- `shared/` runs in both browser and Node. If the screen's controls change, replace `shared/shapeControls.js`.
- Settings, rope lengths, motor IDs and directions: `backend/config/sculpture.config.js` (MEASURE values are placeholders).
- To test with fewer real motors, set `enabled: false` on the drives that aren't connected.

## Homing
Motor position 0 = drum EMPTY. Unwind all rope from all pulleys, press **Home**: every motor is zeroed, then
one at a time each winds up to the rest pose (all sliders 0); the 4 tension ropes go last. The drives forget
their zero at power-off, so home after every power-up. **Start motors** first moves all motors to the current
pose, then follows the model. Emergency stop: the red button or the space bar (also aborts homing).

# iCL-RS Modbus RTU motor tools (Node.js)


```
npm install
npm test                                  # CRC vectors + simulated 12-motor run (no hardware)
node bin/cli.js ports                     # find the FTDI device (/dev/cu.usbserial-XXXX)
node bin/cli.js scan                      # which IDs answer?
node bin/cli.js info                      # bus voltage, alarms, position
node bin/cli.js bench                     # round-trip time -> is 12 motors @ 10 Hz feasible?
node bin/cli.js current 2.0               # peak current in A (start LOW for a first test)
node bin/cli.js zero                      # current shaft position = 0
node bin/cli.js move 1 --rpm 60           # absolute move to 1 rev
node bin/cli.js sine --ids 1 --amp 1 --freq 0.2   # streaming test, Ctrl-C = quick stop
node bin/cli.js sine --mock --ids 1,2,3   # same, against simulated drives
```

Baud: drive ships at 38400 (Pr5.22 = 4). Pass `--baud 38400` at first, or set DIP SW6+SW7 ON for 115200
(recommended for 12 motors). Power-cycle the drive after changing DIPs.

## Layout
- `src/ModbusRtuBus.js`  serial + Modbus RTU master (FC03/06/10, queue, retries, CRC, broadcast)
- `src/IclRsMotor.js`    one drive: status, current, zero, quick stop, `moveToRev()` (single-frame PR0 immediate trigger)
- `src/MotorGroup.js`    fixed-rate loop: `targetFn(t, i) -> revolutions`, speed derived per tick, safety stop on faults
- `src/MockPort.js`      fake drives for development
- `bin/cli.js`           test tool

## Using it from your own algorithm
```js
import { ModbusRtuBus, IclRsMotor, MotorGroup } from './src/index.js';
const bus = new ModbusRtuBus({ path: '/dev/cu.usbserial-XXXX', baudRate: 115200 });
await bus.open();
const motors = [1,2,3 /* ... 12 */].map(id => new IclRsMotor(bus, id));
for (const m of motors) { await m.syncPulsesPerRev(); await m.setZero(); }
const group = new MotorGroup(bus, motors, { rateHz: 10, maxRpm: 300, minRev: -5, maxRev: 5 });
await group.start((t, i) => myAlgorithm(t, i));   // returns revolutions
```
