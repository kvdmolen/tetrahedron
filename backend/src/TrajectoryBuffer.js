/**
 * Recent history of N values (e.g. 16 motor targets) with timestamps, so the motors can
 * replay the model a fixed delay later and MotorGroup can "look ahead" into it.
 */
export class TrajectoryBuffer {
  constructor({ maxAgeMs = 5000 } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.samples = []; // { timeMs, values }
  }

  push(timeMs, values) {
    this.samples.push({ timeMs, values });
    const oldestKept = timeMs - this.maxAgeMs;
    let dropCount = 0;
    while (dropCount < this.samples.length - 2 && this.samples[dropCount + 1].timeMs < oldestKept) dropCount++;
    if (dropCount) this.samples.splice(0, dropCount);
  }

  /** Linear interpolation; before the first / after the last sample it holds that sample. */
  valueAt(timeMs, index) {
    const samples = this.samples;
    if (!samples.length) return undefined;
    if (timeMs <= samples[0].timeMs) return samples[0].values[index];
    const last = samples[samples.length - 1];
    if (timeMs >= last.timeMs) return last.values[index];
    // binary search for the pair around timeMs
    let low = 0, high = samples.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (samples[middle].timeMs <= timeMs) low = middle;
      else high = middle;
    }
    const before = samples[low], after = samples[high];
    const fraction = (timeMs - before.timeMs) / (after.timeMs - before.timeMs);
    return before.values[index] + (after.values[index] - before.values[index]) * fraction;
  }
}
