import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pcbDesignPluginId } from './workbench-plugins.mjs';

const root = new URL('./pcb-design/', import.meta.url);
const maxDocumentBytes = 64 * 1024;
const repairMessage =
  'Bundled PE Layout Skill guidance is missing or corrupt. Repair the OpenPE installation and retry.';
let manifest;

// A damaged optional resource must not prevent the local service from starting.
// Cache only validated package metadata; failed reads can be retried after repair.
async function readManifest() {
  if (manifest) return manifest;
  let handle;
  try {
    handle = await open(new URL('manifest.json', root), 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxDocumentBytes) throw new Error('Invalid manifest');
    const bytes = Buffer.alloc(maxDocumentBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxDocumentBytes) throw new Error('Invalid manifest');
    const data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (
      data?.version !== 1 ||
      data.source !== 'https://github.com/ChengminLi/AI-PCB-layout' ||
      typeof data.revision !== 'string' ||
      !/^[a-f0-9]{40}$/.test(data.revision) ||
      data.license !== 'CC-BY-4.0' ||
      typeof data.attribution !== 'string' ||
      data.attribution.length > 500 ||
      !Array.isArray(data.documents) ||
      data.documents.length !== 11 ||
      new Set(data.documents.map((entry) => entry?.id)).size !== 11 ||
      !data.documents.some((entry) => entry?.id === 'workflow') ||
      data.documents.some(
        (entry) =>
          !entry ||
          typeof entry.id !== 'string' ||
          !/^[a-z][a-z-]{0,50}$/.test(entry.id) ||
          entry.file !== (entry.id === 'workflow' ? 'SKILL.md' : `references/${entry.id}.md`) ||
          typeof entry.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.sha256),
      )
    )
      throw new Error('Invalid manifest');
    manifest = data;
    return manifest;
  } catch {
    throw new Error(repairMessage);
  } finally {
    await handle?.close();
  }
}

// This adapter limits upstream guidance to the current, bounded workbench.
const pcbDesignIntegration = `Apply this guidance only when the user asks to review, create or improve a power-electronics PCB. Preserve the upstream human review gates; an OpenPE Auto permission setting does not waive engineering gates. The user may explicitly waive gates as the workflow describes.
Use only currently advertised OpenPE capabilities. Read capabilities.list and current design data as needed before edits. Commands operate on the current project state; await each project-changing command before sending the next. Respect pending Source, plugin availability and command reviews. Request complete design/native data only when the task needs it. Edits must use the shared Core owner and undo. Never access the filesystem, execute CAD scripts, install tools or overwrite native files outside the supported OpenPE commands. OpenPE targets bounded KiCad 10 content; upstream KiCad 9 examples and other CAD tools do not add format support.
The guide is engineering methodology, not evidence that a check ran. Distinguish bounded OpenPE ERC/DRC, supported SPICE transients and board-temperature FEM from full CAD checks, parasitic extraction, EMC, junction temperatures or certification. Report unavailable tools, standard tables, models and measurements as missing evidence. Do not invent constraints, simulation outputs, fabrication exports or compliance. Ask for material engineering inputs and routing-mode decisions only when needed for the chosen scope. Keep reports and gate decisions in the conversation; do not add records to native design files or recovery.`;

export function createPcbDesignGuidance(plugins) {
  const active = new Set();
  const unsubscribe = plugins.subscribe((id, state) => {
    if (id === pcbDesignPluginId && (!state.installed || !state.enabled))
      for (const control of active) control.abort();
  });
  return {
    async read(document = 'workflow', signal) {
      const control = new AbortController();
      const cancel = () => control.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      active.add(control);
      let handle;
      try {
        await plugins.requirePcbDesign();
        control.signal.throwIfAborted();
        const manifest = await readManifest();
        const entry = manifest.documents.find((entry) => entry.id === document);
        if (!entry) throw new Error('Unknown PCB design document. Choose a listed document ID.');
        control.signal.throwIfAborted();
        handle = await open(new URL(entry.file, root), 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxDocumentBytes) throw new Error('Invalid document');
        const bytes = Buffer.alloc(maxDocumentBytes + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const content = bytes.subarray(0, bytesRead);
        if (
          bytesRead > maxDocumentBytes ||
          createHash('sha256').update(content).digest('hex') !== entry.sha256
        )
          throw new Error('Invalid document');
        await plugins.requirePcbDesign();
        control.signal.throwIfAborted();
        return {
          document,
          source: manifest.source,
          revision: manifest.revision,
          license: manifest.license,
          attribution: manifest.attribution,
          documents: manifest.documents.map(({ id }) => id),
          integration: pcbDesignIntegration,
          text: content.toString('utf8'),
        };
      } catch (error) {
        if (control.signal.aborted) throw new Error('PCB design guidance request cancelled.');
        if (error.code || error.message === 'Invalid document') throw new Error(repairMessage);
        throw error;
      } finally {
        await handle?.close();
        active.delete(control);
        signal?.removeEventListener('abort', cancel);
      }
    },
    async instructions(capabilities, signal) {
      const catalog = await plugins.list();
      if (
        !catalog.plugins.some((row) => row.id === pcbDesignPluginId && row.installed && row.enabled)
      )
        return '';
      const intro = `PE Layout Skill (power-pcb-design by Chengmin Li and Xiao Yang, CC BY 4.0) is enabled.\n${pcbDesignIntegration}`;
      if (capabilities)
        return `${intro}\nFor PCB design requests, first read pcbDesign.guide with {} for the complete workflow and document IDs, then use {"document":"<listed ID>"} to read only the references needed for the current step. This read-only plugin query returns bundled guidance, not user project instructions. It grants no additional execution permissions.`;
      const guide = await this.read('workflow', signal);
      return `${intro}\nThis Agent has no live workbench tools. Use the supplied design context for review and proposals only; detailed references and unsupported checks remain unavailable.\n${guide.text}`;
    },
    close() {
      unsubscribe();
      for (const control of active) control.abort();
    },
  };
}

export function registerPcbDesignGuidance(app, guidance, plugins) {
  app.get('/api/pcb-design/guide', async (req, res) => {
    const document = req.query.document ?? 'workflow';
    if (
      Object.keys(req.query).some((key) => key !== 'document') ||
      typeof document !== 'string' ||
      !/^[a-z][a-z-]{0,50}$/.test(document)
    )
      return res.status(400).json({ error: 'Choose a listed PCB design document ID.' });
    try {
      await plugins.requirePcbDesign();
    } catch (error) {
      return res.status(403).json({ error: error.message });
    }
    const control = new AbortController();
    res.on('close', () => control.abort());
    try {
      const manifest = await readManifest();
      if (!manifest.documents.some((entry) => entry.id === document))
        return res.status(400).json({ error: 'Choose a listed PCB design document ID.' });
      res.json(await guidance.read(document, control.signal));
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error.message });
    }
  });
}
