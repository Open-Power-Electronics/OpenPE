import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeGeneratedFile } from './write-generated-file.mjs';

const root = 'resources/third-party-source/newstroke-10.0.0/';
const bytes = await readFile(root + 'newstroke_font.cpp');
if (
  createHash('sha256').update(bytes).digest('hex') !==
  'dd686d654166869bad4866b107c81e538736c057721ddbf70036a50d8e844de9'
)
  throw new Error('The pinned KiCad 10 Newstroke source has changed.');
// Latin, Latin-1 and Greek glyphs only; no derived CJK/Source Han glyphs.
const glyphs = [...bytes.toString('utf8').matchAll(/^\s*("(?:\\.|[^"\\])*"),/gm)]
  .slice(0, 0x400 - 32)
  .map((match) => JSON.parse(match[1]));
if (glyphs.length !== 992) throw new Error('Incomplete Newstroke glyphs.');
await writeGeneratedFile('lib/manufacturing-font.json', JSON.stringify(glyphs) + '\n');
