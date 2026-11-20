import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

// Only this trusted worker runs in Node. Extension source runs inside QuickJS
// WebAssembly, with no Node objects, module loader, network or filesystem bridge.
let runtime;
let context;
try {
  const quickjs = await getQuickJS();
  runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 2000;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  context = runtime.newContext();
  const evaluate = (source) => {
    const result = context.evalCode(source, 'plugin.js');
    if (result.error) {
      result.error.dispose();
      throw new Error('Plugin execution failed or exceeded its limits.');
    }
    return result.value;
  };
  evaluate(
    'globalThis.registerPlugin = handlers => { globalThis.__openpeHandlers = handlers; };',
  ).dispose();
  evaluate(workerData.source).dispose();
  const result = evaluate(`(() => {
    const [input, context] = JSON.parse(${JSON.stringify(JSON.stringify([workerData.input, workerData.context]))});
    if (!Object.prototype.hasOwnProperty.call(globalThis.__openpeHandlers ?? {}, ${JSON.stringify(workerData.handler)}))
      throw new Error('Missing handler');
    const handler = globalThis.__openpeHandlers?.[${JSON.stringify(workerData.handler)}];
    if (typeof handler !== 'function') throw new Error('Missing handler');
    const result = handler(input, context);
    if (result && typeof result.then === 'function') throw new Error('Handlers must be synchronous');
    return JSON.stringify(result, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite result');
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('Non-JSON result');
      return value;
    });
  })()`);
  const output = context.getString(result);
  result.dispose();
  if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw new Error('Plugin result exceeds 2 MiB.');
  parentPort.postMessage({ output: JSON.parse(output) });
} catch {
  parentPort.postMessage({
    error: 'Plugin execution failed or exceeded its limits. Check the plugin package.',
  });
} finally {
  context?.dispose();
  runtime?.dispose();
}
