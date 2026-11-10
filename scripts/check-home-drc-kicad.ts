import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ProjectCore } from '../core/project-core';
import { loadKiCadPCBDesignRuleLimits, type RuleCheckResult } from '../lib/design-rule-checks';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import { projectFromNativeFiles, type KiCadProjectFiles } from '../lib/kicad-project';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs') as {
  readNativeProject(filename: string): Promise<KiCadProjectFiles>;
};
const output = path.resolve('test-results/home-kicad-drc');
function kicad(...args: string[]) {
  const result = spawnSync(process.env.KICAD_CLI || 'kicad-cli', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `KiCad ${args.slice(0, 2).join(' ')} failed. ${result.error?.message || result.stderr}`,
    );
  return result.stdout.trim();
}
const version = kicad('--version');
assert.match(version, /^10\./);
await mkdir(output, { recursive: true });

const sizeRules: Record<string, string> = {
  'pcb.track-width': 'track_width',
  'pcb.via-drill': 'drill_out_of_range',
  'pcb.pad-drill': 'drill_out_of_range',
  'pcb.via-diameter': 'via_diameter',
  'pcb.annular-ring': 'annular_width',
};
const finding = (type: string, severity: string, ids: string[]) =>
  JSON.stringify([type, severity, ids.toSorted()]);
const summary = [];

for (const entry of homeExampleCatalog) {
  const projectPath = path.resolve(homeExampleNativePath(entry.id));
  const native = await readNativeProject(projectPath);
  const project = projectFromNativeFiles(native);
  const board = project.pcb!;
  const settings = {
    ...loadKiCadPCBDesignRuleLimits(
      native.files.find((file) => file.name === native.entry)!.source,
    ),
    scopes: ['dimensions', 'clearance'],
    useZoneClearance: true,
    useKiCadClearance: true,
  };
  const openpe = (await new ProjectCore(project).query('layout.drc', {
    boardId: board.id,
    settings,
  })) as RuleCheckResult;
  const rules: Record<string, string> = {
    ...sizeRules,
    'pcb.clearance': 'clearance',
    'pcb.short': 'shorting_items',
  };
  const nativeRules = new Set(Object.values(rules));
  const nativeReport = path.join(output, `${entry.file}.kicad.json`);
  kicad(
    'pcb',
    'drc',
    '--format',
    'json',
    '--severity-all',
    '--all-track-errors',
    '--output',
    nativeReport,
    projectPath.replace(/\.kicad_pro$/i, '.kicad_pcb'),
  );
  const report: { violations: { type: string; severity: string; items: { uuid: string }[] }[] } =
    JSON.parse(await readFile(nativeReport, 'utf8'));
  await writeFile(
    path.join(output, `${entry.file}.openpe.json`),
    JSON.stringify(openpe, null, 2) + '\n',
  );
  assert.equal(openpe.truncated, false);
  const footprints = new Set(board.footprints.map((footprint) => footprint.id));
  const actual = openpe.issues
    .map((issue) => {
      assert.ok(Object.hasOwn(rules, issue.ruleId), `${entry.file}: unexpected ${issue.ruleId}`);
      return finding(
        rules[issue.ruleId],
        issue.severity,
        issue.objectIds.filter((id) => !footprints.has(id)),
      );
    })
    .sort();
  const expected = report.violations
    .filter((issue) => nativeRules.has(issue.type))
    .map((issue) =>
      finding(
        issue.type,
        issue.severity,
        issue.items.map((item) => item.uuid),
      ),
    )
    .sort();
  assert.deepEqual(actual, expected, `${entry.file}: DRC findings differ for the comparison scope`);
  summary.push({
    project: entry.file,
    scopes: settings.scopes,
    matched: actual.length,
    otherKiCadFindings: report.violations.length - expected.length,
  });
  console.log(`${entry.file}: ${actual.length} matching findings (${settings.scopes.join(', ')})`);
}
await writeFile(
  path.join(output, 'summary.json'),
  JSON.stringify({ version, projects: summary }, null, 2) + '\n',
);
