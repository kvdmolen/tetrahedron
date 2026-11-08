# Tetra: rope sculpture controller

A tetrahedron of 4 nodes hangs in a 682 mm box (inside the frame) on 16 motorised ropes. A spring model turns the control
inputs into a shape; the server turns that shape into rope lengths and streams them to the motors.

```
npm run install:all     # once: installs backend and frontend
npm run build           # build the screen (frontend/dist)
npm run start:mock      # server with simulated motors   -> http://localhost:4000
npm start               # server with real motors (press Connect in the screen)
npm test                # model vs. reference, motor protocol, paced bus, end-to-end with simulated motors
```

Working on the screen: run the server (`npm run start:mock`) and `npm run dev` side by side, and open the
address `npm run dev` prints (hot reload; it forwards the WebSocket to the server).

## Layout
```
shared/                  runs in both Node and the browser
  tetra.js               geometry, the INPUTS list, inputs -> segment stiffness, TetraModel
  ElasticNetwork.js      generic spring network (rest length 0), exact equilibrium, nodes move like a mass
  timeline.js            timeline format and interpolation (editor now, server playback later)
  winding.js             rope on a single-track drum <-> pulley turns
backend/                 Node server + motor control
  src/server.js          serves frontend/dist, WebSocket /ws, runs SculptureController
  src/SculptureController.js   model at 100 Hz, homing, streaming to the motors, tension ropes
  src/RopeDrive.js       one rope: free length -> motor turns, tension current
  src/MotorGroup.js      fixed-rate streaming loop with look-ahead
  src/IclRsMotor.js      one Leadshine iCL-RS drive (Modbus RTU)
  src/ModbusRtuBus.js    RS485 Modbus master; paced writes don't wait for the USB converter
  src/TimelineStore.js, timelineApi.js   saved timelines: files and the /api/timelines HTTP API
  timelines/             the saved timelines, one <name>.json each
  config/sculpture.config.js   ports, rope lengths, motor IDs, tension, motion settings (MEASURE = placeholder)
  bin/cli.js             stepper test tool (ports, scan, info, take/give, bench, sine, tensiontest, ...)
  servo/                 JMC iHSV servo: register map, P-parameters, test tool (tension alternative)
frontend/                Vue 3 + Vite (composition API, single-file components)
  src/App.vue            3D view on top, timeline at the bottom, motor panel; slider panel hidden (SHOW_INPUT_SLIDERS)
  src/components/        TetraView, TimelinePanel + TimelineEditor + TimelineFileControls, MotorPanel, InputPanel
  src/composables/       useSculptureServer (WebSocket, two-way synced inputs), useTimelineFiles (saved timelines)
manuals/                 motor manuals
```

## The model
Nodes A-D; A and B hang from floor corners, C and D from ceiling corners (opposite pairs: A-B, C-D).
10 elastic segments: 4 suspensions A..D (node -> its suspension point) and 6 connections AB..CD. Each pulls
with force = stiffness × length (rest length 0), so every input setting has exactly one equilibrium, and only
the ratios of the stiffnesses decide the shape.

Inputs (`INPUTS` in `shared/tetra.js`, the single list the screen, server and timeline use), all -1..1:
one per segment (its tension) plus `size`. Inputs work as exponents, stiffness = base × factor^input:
- connection +1: its two nodes ~17 mm apart; suspension +1: the node ~17 mm from its suspension point
- size +1: nodes ~26 mm from their suspension points; size -1: nodes ~15 mm from the centre

The factors are in `DEFAULT_TUNING` (calibrated by `backend/test/tetraModel.test.js`). To add an input, add
it to `INPUTS` and use it in `segmentStiffnesses()`. The equilibrium is solved exactly (a 4×4 linear system
per axis) every 10 ms, and the nodes travel there like a mass: at most `maxNodeSpeedMmPerS` (1500) and
`maxNodeAccelerationMmPerS2` (4500), braking in time (1 m in about 1 s). Every moment is a real pose: rope
lengths come from node positions, so they always fit together; the limits only keep the motion physical.
Inputs that change faster (a fast timeline) are simply not reached.

## Motors
- 16 ropes, 4 per node, numbered per node: suspension, to the opposite node, to the left and the right side
  node. Names: `A` (suspension rope = segment A) and `A:AB` (from A's suspension point over node A to B).
  Motor IDs: A 1-4, B 5-8, C 9-12, D 13-16.
- Steppers (Leadshine iCL57-RS13) on the 12 position ropes; the 4 suspension ropes (motor IDs 1, 5, 9, 13)
  are constant-tension: stalled at a limited current, or on weights (`SUSPENSION_MOTORS = false` in the config, the default for now).
- RS485 at 115200 8N1, DIP SW6+SW7 ON; DIP SW1-5 = motor ID.
- Rope length = free length from the exit point at the corner to the rope's end (corner -> node -> other node for
  the position ropes). Motor position 0 = drum empty = all rope given: 2√2 × box (1929 mm) for the position ropes,
  the longest they can ever get (`MAX_POSITION_ROPE_LENGTH_MM`). Winding direction per motor: `WINDS_CLOCKWISE`
  (seen facing the shaft) and `motor.positiveRotation` in the config.
- Homing (automatic, ropes may be anywhere; `homing` in the config): all motors pull softly (low current, always
  winding a little), so ropes stay just taut and give way when pulled. One position rope at a time winds in
  slowly at half its normal current until it can't go further: its end is at the exit point (free length
  `endFreeLengthMm`), which gives its exact position. With `stepByStep` it then waits on the screen: Confirm (next
  rope), -/+ to jog the rope (on Confirm, that spot counts as the end), or Continue winding (not the end yet: some
  slack, then wind in again). Stop pauses homing at any moment: every rope gives way, e.g. to untangle; Resume
  carries on. The main ropes aren't homed. Homing is kept until a drive loses power (also over an emergency stop
  and disconnect/connect); a restarted drive is noticed (`REG.SESSION_MARKER`).
- Motors only ever move through the model, or through the transition: after homing, Start motors and an emergency
  stop, every rope goes in a straight line (rope length, all at the same pace, plus `slackMm` extra halfway) from
  where it is to the simulation's pose, at a lower current (`transition` in the config). Then SYNCED: the motors
  follow the model ~0.8 s behind, and the 3D view shows that delayed pose (what the sculpture does). Stop motors:
  motors hold (HOMED) and the simulation runs on its own. Tension ropes take their position at their first sync.
- Home here (testing WITHOUT ropes only): skips homing; every motor counts as being at the simulation's current
  pose. With ropes attached the positions would be wrong and the motors would fight.
- Emergency stop: red button or space bar (also aborts homing and the transition).
- Only some motors connected: `npm start -- --motors 2` (comma-separated IDs).

## Timeline
The timeline at the bottom drives the inputs: one lane per input, keyframes with eased curves in between
(playing or scrubbing sends the values to the model). The speed slider plays at 0.1× to 10×.

The slider in front of each lane shows the current value. While paused you can move it, and the model responds:
- A keyframe selected (sliders blue): the slider edits that keyframe. Selecting a keyframe puts the playhead on it;
  moving the playhead away or pressing play deselects it.
- No keyframe selected: the timeline stays as it is (a moved slider turns orange; double-click puts it back). Add
  keyframe puts the moved sliders, and only those, in a keyframe at the playhead, or in the keyframe that's already
  there. Moving the playhead or pressing play hands the sliders back to the timeline.

Loop start and Loop end (optional, shown as thin blue lines): when looping, playback jumps from Loop end (or
the end) back to Loop start (or 0), so a timeline can have an intro and a loop. Give both points the same values
for a smooth loop.

Timelines are saved in `backend/timelines/`, one `<name>.json` per timeline, holding `{ duration, keyframes:
[{ time, values }], loop, speed, loopStart?, loopEnd? }` (see `shared/timeline.js`). `duration` is the total time.
The file name is the name: a movement can be emailed as is, and a received file dropped in that folder shows up
under Open. Save stores under the name in the box: the timeline you opened is overwritten without asking, a new
name makes a copy, and overwriting another timeline asks first. The work in progress is also kept in the browser,
so a reload loses nothing.

Background, measurements, design decisions and open items: `docs/findings.md`.
Ideas for music-driven movement: `docs/music.md`.

Planned: shows that chain saved timelines by name; playback then moves to the server (same interpolation code),
so it doesn't depend on a browser tab staying open.
