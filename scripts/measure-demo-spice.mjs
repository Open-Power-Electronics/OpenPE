import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysisFilename } from '../server/flat-analysis-files.mjs';
import { createProjectSpiceStore } from '../server/project-spice-files.mjs';
import { readNativeSpiceRows } from '../plugins/spice-simulation/host/spice-raw.mjs';
import { spiceProjectDirectory } from '../plugins/runtime/project-data.mjs';
import { voltageWindow } from './home-simulation-verification.ts';

const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sameFile = (left, right) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => left[key] === right[key]);

/** Measure an existing completed record. This never launches or detects a solver. */
export async function measureDemoSpice(directory, { secondaryReturn = 'GND2' } = {}) {
  if (!['GND2', '0'].includes(secondaryReturn))
    throw new Error('Secondary return must be GND2 or an explicitly selected node 0.');
  const input = path.resolve(directory);
  const info = await lstat(input);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    normalize(await realpath(input)) !== normalize(input)
  )
    throw new Error('The input must be a native project directory without links.');
  const projects = (await readdir(input, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.kicad_pro$/i.test(entry.name),
  );
  if (projects.length !== 1)
    throw new Error('The directory must contain exactly one native .kicad_pro project.');
  const projectFile = path.join(input, projects[0].name);
  const stem = path.basename(projectFile, path.extname(projectFile));
  const spiceDirectory = path.join(input, spiceProjectDirectory);
  const manifestFile = path.join(spiceDirectory, analysisFilename(stem, 'manifest.json'));
  const manifestBefore = await lstat(manifestFile);
  const manifestBytes = await readFile(manifestFile);
  const signal = new AbortController().signal;
  const store = createProjectSpiceStore(() => projectFile);
  // These existing read paths validate the current manifest, result checksum,
  // finite display data, requested endpoint and regular artifact identities.
  const saved = await store.readSettings(signal);
  if (!saved) throw new Error('No current completed SPICE record exists.');
  const result = await store.read(saved.key, undefined, signal);
  if (!result) throw new Error('The completed SPICE record changed during measurement.');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.key !== saved.key || !sameFile(manifestBefore, await lstat(manifestFile)))
    throw new Error('The SPICE manifest changed during measurement.');

  const voltageTrace = (name) => {
    const matches = result.traces
      .map((trace, index) => ({ trace, index }))
      .filter(({ trace }) => trace.unit === 'V' && trace.label === `V(${name})`);
    if (matches.length !== 1)
      throw new Error(`Expected one saved compiled voltage trace labelled V(${name}).`);
    return matches[0];
  };
  const secondaryGround = secondaryReturn === 'GND2' ? voltageTrace('GND2') : null;
  if (secondaryReturn === '0' && result.traces.some((trace) => trace.label === 'V(GND2)'))
    throw new Error(
      'A separate GND2 trace exists; use --secondary-return=GND2 for differential voltage.',
    );
  const rails = ['VOUT1', 'VOUT2'].map((name) => {
    const source = voltageTrace(name);
    return {
      name,
      ...source,
      returnIndex: name === 'VOUT2' && secondaryGround ? secondaryGround.index : -1,
      returnVector: name === 'VOUT2' && secondaryGround ? secondaryGround.trace.vector : '0',
      label: name === 'VOUT2' ? `V(VOUT2,${secondaryReturn})` : source.trace.label,
    };
  });
  if (rails[0].trace.vector === rails[1].trace.vector)
    throw new Error('The primary and secondary output vectors must be distinct.');

  const duration = saved.config.stop;
  const start = duration * 0.8;
  const middle = duration * 0.9;
  const deck = {
    stop: duration,
    traces: result.traces.map(({ values, ...trace }) => trace),
  };
  const rawFile = path.join(spiceDirectory, analysisFilename(stem, 'waveforms.raw'));
  const rawBefore = await lstat(rawFile);
  const time = [];
  const voltages = rails.map(() => []);
  let previous;
  const append = (row) => {
    time.push(row[0]);
    rails.forEach(({ index, returnIndex }, rail) =>
      voltages[rail].push(row[index + 1] - (returnIndex < 0 ? 0 : row[returnIndex + 1])),
    );
  };
  const nativeSampleCount = await readNativeSpiceRows(
    rawFile,
    deck,
    (row) => {
      if (row[0] >= start) {
        if (!time.length && previous) append(previous);
        append(row);
      }
      previous = row;
    },
    signal,
  );
  const outputs = Object.fromEntries(
    rails.map(({ name, trace, label, returnVector }, rail) => {
      const tail = voltageWindow(time, voltages[rail], start, duration);
      const firstHalf = voltageWindow(time, voltages[rail], start, middle);
      const secondHalf = voltageWindow(time, voltages[rail], middle, duration);
      const magnitude = Math.abs(tail.mean);
      const metrics = {
        label,
        sourceVectors: { positive: trace.vector, negative: returnVector },
        expression: `${trace.vector} - ${returnVector}`,
        unit: 'V',
        ...tail,
        firstHalfMean: firstHalf.mean,
        secondHalfMean: secondHalf.mean,
        ripplePercent: magnitude ? (tail.peakToPeak / magnitude) * 100 : null,
        driftPercent: magnitude
          ? (Math.abs(secondHalf.mean - firstHalf.mean) / magnitude) * 100
          : null,
      };
      if (
        Object.values(metrics).some((value) => typeof value === 'number' && !Number.isFinite(value))
      )
        throw new Error(`Non-finite voltage-window metrics for ${name}.`);
      return [name, metrics];
    }),
  );
  if (
    !sameFile(rawBefore, await lstat(rawFile)) ||
    !sameFile(manifestBefore, await lstat(manifestFile)) ||
    !(await store.read(saved.key, undefined, signal))
  )
    throw new Error('A completed SPICE artifact changed during measurement.');

  return {
    measuredAt: new Date().toISOString(),
    source: 'Existing completed OpenPE SPICE artifacts; no solver execution.',
    projectFile,
    manifestFile,
    rawFile,
    manifestSha256: digest(manifestBytes),
    storedIdentity: {
      key: saved.key,
      identityVersion: manifest.identityVersion,
      solverVersion: manifest.solverVersion,
      solverSha256: manifest.solverSha256,
      resultSha256: manifest.resultSha256,
    },
    verification: {
      manifestAndResult: 'Validated through the current project SPICE store.',
      waveform:
        'All native raw rows validated for finite values, column units, monotonic time and completion.',
      outputMapping:
        'Saved compiled voltage labels and exact vectors; secondary return subtracted on each full-resolution raw row before statistics.',
      secondaryReturn:
        secondaryReturn === '0'
          ? 'Caller explicitly selected global node 0; no separate GND2 trace exists.'
          : 'Differential V(VOUT2)-V(GND2); floating secondary common-mode is excluded.',
      currentDesignIdentity:
        'Not recompiled or verified; measurements describe the saved artifacts only.',
      solverIdentity:
        'Recorded manifest identity; executable not launched or independently verified.',
    },
    config: saved.config,
    data: {
      resolution: 'Full native raw samples, before display reduction or linearization.',
      nativeSampleCount,
      retainedWindowSampleCount: time.length,
      rawBytes: rawBefore.size,
      rawModifiedAt: rawBefore.mtime.toISOString(),
      startS: start,
      middleS: middle,
      endS: duration,
      meanMethod: 'Trapezoidal time integration with interpolated window boundaries.',
    },
    outputs,
    acceptance: 'Not evaluated. Compare these measurements with the declared scenario criteria.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage =
    'node scripts/measure-demo-spice.mjs --directory=<native-project-directory> [--secondary-return=GND2|0] [--output=<new-json-file>]';
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log(usage);
    } else {
      if (
        args.some((arg) => !/^--(?:directory|output|secondary-return)=.+$/.test(arg)) ||
        args.filter((arg) => arg.startsWith('--directory=')).length !== 1 ||
        args.filter((arg) => arg.startsWith('--output=')).length > 1 ||
        args.filter((arg) => arg.startsWith('--secondary-return=')).length > 1
      )
        throw new Error(usage);
      const directory = path.resolve(args.find((arg) => arg.startsWith('--directory=')).slice(12));
      const outputArg = args.find((arg) => arg.startsWith('--output='));
      const output = outputArg && path.resolve(outputArg.slice(9));
      if (output) {
        const resolvedOutput = path.join(
          await realpath(path.dirname(output)),
          path.basename(output),
        );
        const relative = path.relative(directory, resolvedOutput);
        if (
          !relative ||
          (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        )
          throw new Error(
            'Write the report outside the input project directory to preserve its files.',
          );
      }
      const secondaryReturn =
        args.find((arg) => arg.startsWith('--secondary-return='))?.slice(19) ?? 'GND2';
      const report = await measureDemoSpice(directory, { secondaryReturn });
      const text = JSON.stringify(report, null, 2) + '\n';
      if (output) await writeFile(output, text, { flag: 'wx' });
      console.log(text);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
