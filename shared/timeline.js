// Timelines: keyframed values over time. Used by the timeline editor in the browser, and meant for the
// server too (playing saved timelines and programs), so both follow exactly the same curves.
//
// A timeline is plain JSON:
//   { "duration": 10, "keyframes": [{ "time": 0, "values": { "A": 0, ... } }, ..., { "time": 10, "values": { ... } }] }
// keyframes are sorted by time; the first (at 0) and the last (at duration) hold every parameter, the ones
// in between only the parameters they control. Between two keyframes that control a parameter, its value
// follows the EASE curve.
//
// Optional "loopStart" and "loopEnd" (seconds): when looping, playback jumps from loopEnd (default: the end)
// to loopStart (default: 0), so a timeline can have an intro and a loop whose both ends match.
//
// Optional playback settings: "loop" (true: repeat, default false) and "speed" (1 = as written, 2 = twice as fast).
//
// Saved timelines are one file each, <name>.json, holding exactly this object: the file name is the
// timeline's name, so a movement can be emailed, or renamed in the Finder.

/** Ease between two keyframes: cubic bezier through (0,0), (.36,0), (.63,1), (1,1). */
export const EASE = [0.36, 0, 0.63, 1];

const bezier = (control1, control2, s) => 3 * (1 - s) * (1 - s) * s * control1 + 3 * (1 - s) * s * s * control2 + s * s * s;

/** Eased progress (0..1) for linear progress u (0..1), following the drawn curve exactly. */
export function ease(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let low = 0, high = 1;
  for (let i = 0; i < 24; i++) {
    const middle = (low + high) / 2;
    if (bezier(EASE[0], EASE[2], middle) < u) low = middle;
    else high = middle;
  }
  return bezier(EASE[1], EASE[3], (low + high) / 2);
}

/** Value of one parameter at `time`, from keyframes sorted by time. */
export function valueAt(keyframes, parameterId, time, defaultValue = 0) {
  let previous = null, next = null;
  for (const keyframe of keyframes) {
    if (keyframe.values[parameterId] === undefined) continue; // a plain read, which Vue tracks (Object.hasOwn isn't)
    if (keyframe.time <= time) previous = keyframe;
    else {
      next = keyframe;
      break;
    }
  }
  if (!previous) return next ? next.values[parameterId] : defaultValue;
  if (!next) return previous.values[parameterId];
  const from = previous.values[parameterId], to = next.values[parameterId];
  return from + (to - from) * ease((time - previous.time) / (next.time - previous.time));
}

/** All parameter values at `time`: { id: value }. parameters: [{ id, default }]. */
export function valuesAt(timeline, parameters, time) {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, valueAt(timeline.keyframes, parameter.id, time, parameter.default ?? 0)]));
}

const MAX_NAME_LENGTH = 80;

/** A timeline name that is safe as a file name ('' if nothing is left). */
export function cleanTimelineName(name) {
  const stripEnds = (text) => text.replace(/^[.\s]+|[.\s]+$/g, '');
  return stripEnds(stripEnds(String(name).replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')).slice(0, MAX_NAME_LENGTH));
}

/** Checks (untrusted) timeline data and returns a clean { duration, keyframes }; throws if it isn't one. */
export function parseTimeline(data) {
  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
  const fail = (problem) => {
    throw new Error(`Invalid timeline: ${problem}`);
  };
  if (!isNumber(data?.duration) || data.duration <= 0) fail('duration must be a positive number');
  if (!Array.isArray(data.keyframes)) fail('keyframes must be a list');
  const keyframes = data.keyframes.map((keyframe) => {
    const { time, values } = keyframe ?? {};
    if (!isNumber(time) || time < 0) fail('every keyframe needs a time');
    if (typeof values !== 'object' || values === null || !Object.values(values).every(isNumber)) fail('keyframe values must be numbers');
    return { time, values };
  });
  const timeline = { duration: data.duration, keyframes: keyframes.sort((a, b) => a.time - b.time) };
  for (const loopPoint of ['loopStart', 'loopEnd']) {
    const time = data[loopPoint];
    if (time === undefined || time === null) continue;
    if (!isNumber(time) || time < 0) fail(`${loopPoint} must be a time`);
    timeline[loopPoint] = time;
  }
  if (data.loop !== undefined) {
    if (typeof data.loop !== 'boolean') fail('loop must be true or false');
    timeline.loop = data.loop;
  }
  if (data.speed !== undefined) {
    if (!isNumber(data.speed) || data.speed <= 0) fail('speed must be a positive number');
    timeline.speed = data.speed;
  }
  return timeline;
}
