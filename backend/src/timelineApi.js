import { InvalidTimeline, TimelineNotFound } from './TimelineStore.js';

// HTTP API for saved timelines:
//   GET    /api/timelines          [{ name, duration }, ...]
//   GET    /api/timelines/<name>   the timeline { duration, keyframes }
//   PUT    /api/timelines/<name>   save it (body: the timeline as JSON)
//   DELETE /api/timelines/<name>

const MAX_BODY_BYTES = 5 * 1024 * 1024;

class BodyTooLarge extends Error {}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge('Timeline too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InvalidTimeline('The timeline is not valid JSON');
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).end(JSON.stringify(body));
}

function statusOf(error) {
  if (error instanceof InvalidTimeline) return 400;
  if (error instanceof TimelineNotFound) return 404;
  if (error instanceof BodyTooLarge) return 413;
  return 500;
}

export async function handleTimelineRequest(store, request, response) {
  const [, api, resource, encodedName, ...rest] = new URL(request.url, 'http://localhost').pathname.split('/');
  if (api !== 'api' || resource !== 'timelines' || rest.length) return sendJson(response, 404, { error: 'Not found' });
  try {
    const name = encodedName ? decodeURIComponent(encodedName) : null;
    if (!name && request.method === 'GET') return sendJson(response, 200, await store.list());
    if (name && request.method === 'GET') return sendJson(response, 200, await store.read(name));
    if (name && request.method === 'PUT') return sendJson(response, 200, await store.write(name, await readJsonBody(request)));
    if (name && request.method === 'DELETE') {
      await store.remove(name);
      return response.writeHead(204).end();
    }
    return sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    const status = error instanceof URIError ? 400 : statusOf(error);
    if (status === 500) console.error(`Timeline request failed: ${error.message}`);
    return sendJson(response, status, { error: status === 500 ? 'Could not read or write the timeline file' : error.message });
  }
}
