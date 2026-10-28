import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { defaultAppearance, parseAppearance, validateAppearance } from './appearance-format.mjs';

export function registerAppearance(app, dataDir, atomicWrite) {
  const file = path.join(dataDir, 'appearance-v1.json');
  let saves = Promise.resolve();
  app.get('/api/appearance', async (_req, res) => {
    await saves;
    try {
      res.json(parseAppearance(await readFile(file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') res.json(defaultAppearance);
      else
        res
          .status(500)
          .json({ error: 'Could not read appearance settings. The saved file was preserved.' });
    }
  });
  app.post('/api/appearance', async (req, res) => {
    let settings;
    try {
      settings = validateAppearance(req.body);
    } catch {
      return res.status(400).json({ error: 'Invalid appearance settings.' });
    }
    const write = saves.then(() => atomicWrite(file, JSON.stringify(settings)));
    saves = write.catch(() => {});
    try {
      await write;
      res.json(settings);
    } catch {
      res.status(500).json({ error: 'Could not save appearance settings. Try again.' });
    }
  });
}
