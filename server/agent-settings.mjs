import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { defaultAgentSettings, validateAgentSettings } from './agent-settings-format.mjs';

export function registerAgentSettings(app, dataDir, atomicWrite) {
  const file = path.join(dataDir, 'agent-settings-v1.json');
  let saves = Promise.resolve();
  app.get('/api/agent-settings', async (_req, res) => {
    await saves;
    try {
      res.json(validateAgentSettings(JSON.parse(await readFile(file, 'utf8'))));
    } catch (error) {
      if (error.code === 'ENOENT') res.json(defaultAgentSettings);
      else
        res
          .status(500)
          .json({ error: 'Could not load Agent settings. The saved file was preserved.' });
    }
  });
  app.post('/api/agent-settings', async (req, res) => {
    let settings;
    try {
      settings = validateAgentSettings(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const write = saves.then(() => atomicWrite(file, JSON.stringify(settings)));
    saves = write.catch(() => {});
    try {
      await write;
      res.json(settings);
    } catch {
      res.status(500).json({ error: 'Could not save Agent settings. Try again.' });
    }
  });
}
