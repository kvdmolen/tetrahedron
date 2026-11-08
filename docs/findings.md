# Findings and decisions

What we learned building and testing Tetra, and why the software works the way it does. The README describes
how to use it; this file is the background. Last updated 2026-11-08.

## Status

- Works with the 12 position motors (IDs 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16), ropes not yet attached.
  The 4 main (suspension) ropes hang on weights: `SUSPENSION_MOTORS = false` in the config.
- Verified on the real motors: the bus, `take`/`give` per motor, homing screens, the transition, SYNCED following.
- Not yet verified with ropes attached: homing force (does a rope stall reliably at its end, no false stops),
  `endFreeLengthMm`, the transition's current and slack, motors at high speed.
- Nothing of this work is committed yet: everything since commit `a748edb` is uncommitted.

## Hardware and wiring

- **RS485:** Modbus RTU, 115200 8N1. DIP SW6+SW7 ON, SW1-5 = motor ID. SW8 is the 120 Ω terminator: ON only on
  the last drive of the chain. Daisy chain, same polarity everywhere, and connect GND along the chain. The two
  RS485 ports on a drive are most likely passed through (check by continuity), so in/out direction doesn't matter.
- **USB converter (FTDI):** adds ~16 ms to every reply. That's why moves are sent as "paced writes" (don't wait
  for the reply), about 3x more motors per tick.
- **Power:** 2 × 400 W 48 V supplies, 6 motors each; later a third 400 W for the 4 main motors. Join the minus
  (V−) of all supplies with a thick wire or one star point; never the plus. RS485 needs a common reference, and
  without a thick minus link motor current would flow back through the thin RS485 GND and the USB converter.
  Switch all supplies on together.

## Drives (Leadshine iCL57-RS13)

- Positions: commanded (profile) position in pulses (Pr0.00, 10000/turn); encoder feedback is 65536 counts/turn.
  Set-zero shifts the drive's move targets but not its position registers; the software keeps its own reference
  (`zeroPulses`, `offsetPulses` in `IclRsMotor`). Drives forget everything at power-off.
- Direction: `motor.positiveRotation` is `'ccw'` (set by you after testing with `take`). Pr0.03 left at factory.
- Following-error alarm (Pr0.05, encoder counts): factory 4000 (~0.06 turn). Homing raises it to 65535 (~1 turn)
  and restores it afterwards for position motors. Pulling a rope more than ~1 turn faster than the motor follows
  trips the alarm.
- Tension (measured 2026-10-09, rope at ~65 mm radius): 0.8 A ~ 0.35 kg, 1.5 A ~ 1 kg, 2.5 A ~ 2 kg, 4.5 A ~ 3-4 kg.
  Stalled, the drive pulls with constant force, smooth and quiet. Basis for the future constant-tension main motors.
- Restart detection: the server writes its own number into Pr9.14 (pause time of path 1, never used) in RAM. After
  a power cycle the drive reloads the saved value, so the server knows that drive lost its position. Don't use
  `--save` in the CLI while the server runs (it would store that number and hide a restart).

## Geometry and ropes

- Box: 682 mm inside the frame (where nodes and ropes move). Model units: the box runs from -2 to +2.
- Free length = from the exit point at the corner to the rope's end (corner -> node -> other node for position ropes).
- Motor position 0 = drum empty = all rope given. Position ropes: 2√2 × 682 = **1929 mm** on each drum, the longest
  they can ever get (nodes stay inside the tetrahedron of the 4 suspension corners).
- Drum: 60 mm core diameter, 4 mm per rope layer (the rope flattens when wound). Single track: the rope spirals.
- Rope ends: knots are tiny; minimum free length 30 mm (`minFreeLengthMm`), and homing's "end reached" = 30 mm
  free (`endFreeLengthMm`, still to MEASURE).
- Wind direction (facing the shaft): clockwise for motors 1, 4, 5, 8, 9, 11, 13, 15; counter-clockwise for the rest.

## The key insight: ropes that fight

- The 12 position-rope lengths are not independent. Each pair of nodes has two ropes that share the stretch between
  the nodes (A:AB and B:AB), which gives 3 fixed relations between the 12 lengths. If the motors break them, ropes
  fight each other (risk of tearing) or go slack.
- Any real pose satisfies them, so the model's output always does, at any speed: rope lengths are measured from
  node positions. The model's lag behind fast inputs is smoothing, never an impossible configuration.
- A straight line in rope length between two real poses also satisfies them (the relations are linear), and so does
  the same extra slack on every rope. That's why the transition is safe.
- What breaks them: motors not moving in step. For example, motors with different speeds or ramps, or a motor
  capped at max rpm. Another case: each motor's own point-to-point move. And the bus order: motors get their
  commands one after another, so targets must be calculated for each command's own send time (fixed in
  `MotorGroup`; it was costing up to 15 mm between ropes in fast transitions).
- The 12 position ropes fix only 9 of the 12 node coordinates; the main ropes (weights) take the other 3. So the
  inputs or the full pose can't be reconstructed from motor positions; we decided we don't need to (transition).

## Model motion

- Every 10 ms the exact equilibrium for the inputs is solved (linear system, not iterative). The nodes travel there
  like a mass: max 1500 mm/s, max 4500 mm/s² (1 m in ~1 s), braking computed for 10 ms steps (no overshoot; the
  continuous formula overshot 7.5 mm). Settings: `maxNodeSpeedMmPerS`, `maxNodeAccelerationMmPerS2`.
- The old approach (10 % of the way per step, 1000 mm/s cap) went from 0 to 1 m/s in 10 ms: far too violent.
- At 1.5 m/s a rope can change up to ~2× as fast as a node: ~700 rpm on an empty drum. `motion.maxRpm` is 1000;
  a capped motor falls out of step, so check the motors manage this speed with a fast timeline.
- The calibration (+1 on an input ~ 17 mm) scales with the box; the shape is box-independent.

## Motor states and flows

- **States:** disconnected → idle ↔ homing | syncing (transition) → streaming (SYNCED). Screen status: NOT HOMED,
  homing…, TRANSITION…, SYNCED, HOMED (motors hold, simulation runs on its own).
- **Homing:** every motor pulls softly (low current). One position rope at a time winds in at half current until
  the shaft lags its command (`stallLagTurns`): its end is at the exit point. Then Confirm, −/+ jog (5 mm), or
  Continue winding (50 mm slack first). Stop/Resume at any time (ropes give way, e.g. to untangle). Soft pulling never
  winds a found rope past its end, nor any drum more than all its rope + 1 turn. Without this limit, drums with no
  rope spun endlessly. After the last Confirm the transition starts by itself.
- **Transition:** from wherever the motors are to the simulation's current pose. Each rope gets a straight eased
  line in free length, all at the same fraction, plus 20 mm slack (most halfway), at half current. It lasts at least
  4 s, longer above 100 mm/s. The model holds still and resumes 0.8 s before the end, so the motors go straight on
  into it. Used after homing, on Start motors and after an emergency stop (`transition` in the config).
- **Synced:** motors follow the model 0.8 s behind (`motorDelayMs`, for look-ahead); the 3D view then shows that
  delayed pose, i.e. what the sculpture does. Sliders stay live.
- **Homing is kept** until a drive loses power: across an emergency stop, a failed or stopped re-homing (the
  previous homing stays), and disconnect/connect. Restarting the server forgets it.
- **Home here:** testing without ropes only; every motor counts as being at the simulation's pose.
- **Tension (main) motors, for later:** soft-pulled during homing; they get their position at the end of their
  first transition (stalled against the rope = at the model's length). Untested on hardware.

## Testing

- `npm test` (in backend): model vs. the reference algorithm, calibration, motion limits, overshoot, protocol,
  paced bus, timelines, and the whole chain end to end with simulated drives (homing with the screen's controls,
  transition in step, slack, synced following, homing kept, restart detection, Home here).
- Simulated drives (`MockPort`): each position rope starts somewhere on its drum with an end stop where its end
  reaches the exit; they keep running over a disconnect, like real ones. In mock mode homing runs 10× faster.
- Screen tests by Claude run on port 4100 (`.claude/launch.json`: `tetra-mock-alt-port`); port 4000 is yours.
- CLI (in backend): `node bin/cli.js scan`, `info --ids 2`, `take 0.25 --ids 2 --rpm 30` / `give …` (prints which way
  each shaft should turn), `params`, `tensiontest`. Mark a shaft and `take 1` to check one turn is one turn.

## Open items

- MEASURE `homing.endFreeLengthMm` (free length when the knot is at the exit) and the main ropes' length (1500 mm placeholder).
- With ropes on: is half current enough to beat friction and the soft pulls, and low enough to be safe? Is
  `softCurrentA` 0.4 right? Is `stallLagTurns` 0.25 reliable (false stops give a wrong position)?
- Transition feel: `transition.currentFraction` 0.5; try 0.25 if it feels too strong.
- Fast timelines: do the motors keep up at ~700 rpm on 48 V?
- Main ropes on motors later: `SUSPENSION_MOTORS = true`, their own supply, tension settings.
- Planned: server-side timeline playback and shows; music-driven movement (`docs/music.md`).
