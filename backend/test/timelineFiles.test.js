// Saved timelines: names, the file store and the HTTP API, on a temporary folder.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTimelineName, ease, parseTimeline, valueAt } from '../../shared/timeline.js';
import { InvalidTimeline, TimelineNotFound, TimelineStore } from '../src/TimelineStore.js';
import { handleTimelineRequest } from '../src/timelineApi.js';

const directory = await mkdtemp(join(tmpdir(), 'tetra-timelines-'));
const store = new TimelineStore(join(directory, 'created-on-first-save'));
const timeline = { duration: 4, keyframes: [{ time: 0, values: { A: 0, size: 0.5 } }, { time: 4, values: { A: 1, size: -1 } }] };

// 1. Names
assert.equal(cleanTimelineName('  Slow breath 2 '), 'Slow breath 2');
assert.equal(cleanTimelineName('a/b\\c:d'), 'a-b-c-d');
assert.equal(cleanTimelineName('../../etc/passwd'), '-..-etc-passwd');
assert.equal(cleanTimelineName('...'), '');
assert.equal(cleanTimelineName('x'.repeat(200)).length, 80);
for (const name of ['  a. ', 'a/b', '.hidden', `${'x'.repeat(79)} y`]) assert.equal(cleanTimelineName(cleanTimelineName(name)), cleanTimelineName(name), name);

// 2. Validation
assert.deepEqual(parseTimeline({ duration: 2, extra: 1, keyframes: [{ time: 2, values: { A: 1 } }, { time: 0, values: {} }] }), { duration: 2, keyframes: [{ time: 0, values: {} }, { time: 2, values: { A: 1 } }] });
for (const bad of [null, {}, { duration: 0, keyframes: [] }, { duration: 1 }, { duration: 1, keyframes: [{ time: -1, values: {} }] }, { duration: 1, keyframes: [{ time: 0, values: { A: 'x' } }] }, { duration: 1, keyframes: [{ time: 0 }] }, { duration: 1, keyframes: [null] }]) {
  assert.throws(() => parseTimeline(bad), /Invalid timeline/, JSON.stringify(bad));
}

// optional loop points are kept, empty ones left out, wrong ones refused
assert.deepEqual(parseTimeline({ duration: 2, keyframes: [], loopStart: 0.5, loopEnd: 1.5 }), { duration: 2, keyframes: [], loopStart: 0.5, loopEnd: 1.5 });
assert.deepEqual(parseTimeline({ duration: 2, keyframes: [], loopStart: null, loopEnd: 1 }), { duration: 2, keyframes: [], loopEnd: 1 });
assert.throws(() => parseTimeline({ duration: 2, keyframes: [], loopStart: 'x' }), /loopStart/);
assert.throws(() => parseTimeline({ duration: 2, keyframes: [], loopEnd: -1 }), /loopEnd/);

// and so are the playback settings
assert.deepEqual(parseTimeline({ duration: 2, keyframes: [], loop: true, speed: 0.316 }), { duration: 2, keyframes: [], loop: true, speed: 0.316 });
assert.deepEqual(parseTimeline({ duration: 2, keyframes: [], loop: false, speed: 1 }), { duration: 2, keyframes: [], loop: false, speed: 1 });
assert.throws(() => parseTimeline({ duration: 2, keyframes: [], loop: 'yes' }), /loop/);
for (const speed of [0, -1, 'x']) assert.throws(() => parseTimeline({ duration: 2, keyframes: [], speed }), /speed/);

// exact at the keyframes themselves, no tiny rounding left-overs
assert.equal(ease(0), 0);
assert.equal(ease(1), 1);
assert.equal(valueAt(timeline.keyframes, 'A', 0), 0);
assert.equal(valueAt(timeline.keyframes, 'A', 4), 1);

// 3. The store: empty, save, list, read, overwrite, delete
assert.deepEqual(await store.list(), []);
await store.write('Slow breath', timeline);
await store.write('another', { ...timeline, duration: 8 });
assert.deepEqual(await store.list(), [{ name: 'another', duration: 8 }, { name: 'Slow breath', duration: 4 }]);
assert.deepEqual(await store.read('Slow breath'), timeline);
await store.write('looped', { ...timeline, loop: true, speed: 2.5, loopStart: 1, loopEnd: 3 });
assert.deepEqual(await store.read('looped'), { ...timeline, loop: true, speed: 2.5, loopStart: 1, loopEnd: 3 });
await store.remove('looped');
await store.write('Slow breath', { ...timeline, duration: 5 });
assert.equal((await store.read('Slow breath')).duration, 5);
const files = await readdir(store.directory);
assert.deepEqual(files.sort(), ['Slow breath.json', 'another.json'], 'no temporary files left');
assert.deepEqual(Object.keys(JSON.parse(await readFile(join(store.directory, 'another.json'), 'utf8'))), ['duration', 'keyframes']);

// names that could escape the folder are refused, by the store itself
for (const name of ['../outside', 'a/b', '..', '', '.hidden']) await assert.rejects(() => store.write(name, timeline), InvalidTimeline, name);
await assert.rejects(() => store.read('nothing'), TimelineNotFound);
await assert.rejects(() => store.remove('nothing'), TimelineNotFound);
await assert.rejects(() => store.write('bad', { duration: -1, keyframes: [] }), InvalidTimeline);

// a broken file someone dropped in the folder doesn't break the list
await writeFile(join(store.directory, 'broken.json'), '{ not json');
await writeFile(join(store.directory, 'notes.txt'), 'hello');
const originalWarn = console.warn;
console.warn = () => {};
assert.deepEqual((await store.list()).map((entry) => entry.name), ['another', 'Slow breath']);
console.warn = originalWarn;
await assert.rejects(() => store.read('broken'), InvalidTimeline);
await rm(join(store.directory, 'broken.json'));
console.log('timeline names, validation and file store ok');

// 4. The HTTP API
const server = http.createServer((request, response) => handleTimelineRequest(store, request, response));
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}/api/timelines`;
const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
assert.deepEqual((await call('')).body.map((entry) => entry.name), ['another', 'Slow breath']);
assert.deepEqual((await call('/Slow%20breath')).body.duration, 5);
assert.deepEqual((await call('/caf%C3%A9%20%23%201', 'PUT', timeline)), { status: 200, body: { name: 'café # 1', duration: 4 } });
assert.deepEqual((await call('/caf%C3%A9%20%23%201')).body, timeline);
assert.equal((await call('/caf%C3%A9%20%23%201', 'DELETE')).status, 204);
assert.equal((await call('/caf%C3%A9%20%23%201')).status, 404);
assert.equal((await call('/..%2F..%2Fescaped', 'PUT', timeline)).status, 400);
assert.equal((await call('/%E0%A4%A', 'GET')).status, 400);
assert.equal((await call('/x', 'PUT', 'not json')).status, 400);
assert.equal((await call('/x', 'PUT', { duration: 1 })).status, 400);
assert.equal((await call('/x', 'POST', timeline)).status, 405);
assert.equal((await call('', 'DELETE')).status, 405);
assert.equal((await call('/a/b')).status, 404);
assert.equal((await call('/huge', 'PUT', 'x'.repeat(6 * 1024 * 1024))).status, 413);
assert.deepEqual(await readdir(directory), ['created-on-first-save'], 'nothing written outside the folder');
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
await rm(directory, { recursive: true });
console.log('timeline API ok');
