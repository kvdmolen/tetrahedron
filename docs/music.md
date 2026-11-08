# Music-driven movement (ideas, not built yet)

Besides the timeline, the sculpture could move to music: not only the beat, but its character
(jazz moves oddly, classical elegantly, punk/rock technically).

## Analysis: three time scales
The FFT is the base, but a raw spectrum is far too jittery for ropes; derive slower descriptors from it.

| Scale | Captures | Features |
|---|---|---|
| Fast (beat, ~0.5 s) | pulse, attacks | beat/downbeat phase, onsets, bass energy |
| Medium (bar/phrase, 2-10 s) | energy and colour | loudness, brightness (spectral centroid), pitch register, chroma |
| Slow (10-60 s) | character | rhythm regularity, syncopation/swing, harmonic complexity, distortion/noisiness, dynamic range, arousal/valence |

Character from continuous descriptors rather than genre labels (they work for music without a genre and don't jump):
- classical: smooth loudness curve, wide dynamics, few sharp attacks, rich consonant harmony
- jazz: swing (uneven 8ths), off-beat accents, complex chords, unpredictable onsets
- punk/rock: dense attacks, distorted (flat, noisy) spectrum, steady 4/4, high constant energy

Pretrained genre/mood classifiers can be an extra, heavily smoothed signal (unreliable on a few seconds of audio).

## Libraries
- Python (strongest): madmom and BeatNet (real-time beat/downbeat/tempo, predict the next beat), Essentia
  (features + pretrained genre/mood/danceability/arousal-valence models), aubio (light real-time onsets/beat/pitch),
  librosa (offline analysis of whole tracks).
- Browser/JS: Web Audio AnalyserNode (FFT), Meyda (RMS, centroid, flatness, chroma, MFCC), Essentia.js (WASM,
  some of the models). Fine for prototyping; beat tracking is clearly better in Python.

## Mapping to the 11 inputs
- character -> movement vocabulary: classical = long eased curves, symmetric breathing on `size`, slow pair handovers;
  jazz = asymmetry, accents just after the beat, a slightly random walk through the pairs; rock = crisp moves landing
  on the beat then holds, alternating pairs (AB/CD, AC/BD)
- loudness / bass -> `size` (breathing with the energy)
- pitch register / brightness -> vertical tilt (A, B hang from the floor, C, D from the ceiling)
- beat -> small pulses on top, not the movement itself

## Physical limits
- At 120 BPM a beat is 0.5 s, about one model response time: beats can only be small accents; big moves follow phrases.
- Motors play the model ~0.8 s late: schedule beat moves 0.8 s early (beat trackers predict the next beat).
  Reacting to beats already heard always looks late.
- A microphone also hears the steppers: prefer line-in or a loopback of the music source.

## Two modes
1. Live: analyse incoming audio, drive the inputs continuously (any music, slightly late, no foresight).
2. Pre-analysed: analyse a whole track offline (librosa/madmom + structure: intro/verse/chorus/drop) and generate a
   timeline file in the existing format: perfect sync and anticipation, and editable in the timeline editor.

## Suggested architecture
A small Python "ears" process (madmom/BeatNet + Essentia) sends ~10 smoothed descriptors and beat predictions to the
Node server over WebSocket; the server does the choreography (mapping, latency compensation, blending with a
running timeline) and stays the only one talking to the motors. First experiment: browser-only with Meyda,
loudness on `size` and brightness on tilt, to see whether it already feels musical.
