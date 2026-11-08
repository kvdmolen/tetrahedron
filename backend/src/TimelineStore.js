import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanTimelineName, parseTimeline } from '../../shared/timeline.js';

const EXTENSION = '.json';

export class InvalidTimeline extends Error {}
export class TimelineNotFound extends Error {}

/** Saved timelines: one <name>.json per timeline in a folder (see shared/timeline.js). */
export class TimelineStore {
  constructor(directory) {
    this.directory = directory;
  }

  _path(name) {
    if (!name || name !== cleanTimelineName(name)) throw new InvalidTimeline(`Invalid timeline name: ${name}`);
    return join(this.directory, name + EXTENSION);
  }

  /** All saved timelines as [{ name, duration }], sorted by name. Unusable files are skipped with a warning. */
  async list() {
    const fileNames = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const timelines = [];
    for (const fileName of fileNames.filter((file) => file.endsWith(EXTENSION))) {
      const name = fileName.slice(0, -EXTENSION.length);
      try {
        const { duration } = await this.read(name);
        timelines.push({ name, duration });
      } catch (error) {
        console.warn(`Skipping timeline file ${fileName}: ${error.message}`);
      }
    }
    return timelines.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name) {
    let text;
    try {
      text = await readFile(this._path(name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new TimelineNotFound(`No timeline named ${name}`);
      throw error;
    }
    return this._parse(text);
  }

  /** Save a timeline. Written to a temporary file first, so a crash can't leave a half-written timeline. */
  async write(name, data) {
    const path = this._path(name);
    let timeline;
    try {
      timeline = parseTimeline(data);
    } catch (error) {
      throw new InvalidTimeline(error.message);
    }
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = join(this.directory, `.saving-${process.pid}-${Date.now()}`);
    await writeFile(temporaryPath, `${JSON.stringify(timeline, null, 2)}\n`);
    await rename(temporaryPath, path);
    return { name, duration: timeline.duration };
  }

  async remove(name) {
    await rm(this._path(name)).catch((error) => {
      throw error.code === 'ENOENT' ? new TimelineNotFound(`No timeline named ${name}`) : error;
    });
  }

  _parse(text) {
    try {
      return parseTimeline(JSON.parse(text));
    } catch (error) {
      throw new InvalidTimeline(error.message);
    }
  }
}
