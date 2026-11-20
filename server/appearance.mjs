import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  defaultAppearance,
  defaultLayoutPreferences,
  validateAppearance,
  validateLayoutPreferences,
} from './appearance-format.mjs';

function registerPreference(app, atomicWrite, { route, file, label, defaults, validate }) {
  let saves = Promise.resolve();
  app.get(route, async (_req, res) => {
    await saves;
    try {
      res.json(validate(JSON.parse(await readFile(file, 'utf8'))));
    } catch (error) {
      if (error.code === 'ENOENT') res.json(defaults);
      else
        res.status(500).json({ error: `Could not read ${label}. The saved file was preserved.` });
    }
  });
  app.post(route, async (req, res) => {
    let settings;
    try {
      settings = validate(req.body);
    } catch {
      return res.status(400).json({ error: `Invalid ${label}.` });
    }
    const write = saves.then(() => atomicWrite(file, JSON.stringify(settings)));
    saves = write.catch(() => {});
    try {
      await write;
      res.json(settings);
    } catch {
      res.status(500).json({ error: `Could not save ${label}. Try again.` });
    }
  });
}

export function registerAppearance(app, dataDir, atomicWrite) {
  registerPreference(app, atomicWrite, {
    route: '/api/appearance',
    file: path.join(dataDir, 'appearance-v1.json'),
    label: 'appearance settings',
    defaults: defaultAppearance,
    validate: validateAppearance,
  });
  registerPreference(app, atomicWrite, {
    route: '/api/layout-preferences',
    file: path.join(dataDir, 'layout-preferences-v1.json'),
    label: 'layout preferences',
    defaults: defaultLayoutPreferences,
    validate: validateLayoutPreferences,
  });
}
