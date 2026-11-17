// Diagnostic-only camera adapter. Never imported by the application.
// It preserves the existing navigation inputs/clocks while comparing transient
// compositor motion with native viewBox changes on the same committed SVG.
export function installLayoutCompositorPrototype(svg) {
  const canvas = svg.closest('.layout-canvas');
  const originalSetAttribute = svg.setAttribute;
  const originalDescriptor = Object.getOwnPropertyDescriptor(svg, 'setAttribute');
  const originalStyle = svg.getAttribute('style');
  const originalCanvasStyle = canvas.getAttribute('style');
  const viewport = svg.getBoundingClientRect();
  const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
  const matrix = () => {
    const value = svg.getScreenCTM();
    return Object.fromEntries(keys.map((key) => [key, value[key]]));
  };
  const geometry = () => ({ viewport: svg.getBoundingClientRect().toJSON(), screenCTM: matrix() });
  const before = geometry();
  const content = svg.innerHTML;
  let base = svg.getAttribute('viewBox').split(' ').map(Number);
  let current = svg.getAttribute('viewBox');
  let pending = false;
  let timer;
  let disposed = false;
  const samples = [];
  const flushes = [];
  const delayMs = 120;

  function flush(reason = 'explicit') {
    clearTimeout(timer);
    if (!pending || disposed) return;
    const started = performance.now();
    const transformed = matrix();
    originalSetAttribute.call(svg, 'viewBox', current);
    svg.style.transform = 'none';
    base = current.split(' ').map(Number);
    pending = false;
    // Diagnostic verification includes the actual native layout rebase cost.
    // That cost is reported separately even when it runs after the input frame.
    const rebased = matrix();
    flushes.push({
      reason: typeof reason === 'string' ? reason : reason.type,
      elapsedMs: performance.now() - started,
      maximumMatrixError: Math.max(...keys.map((key) => Math.abs(transformed[key] - rebased[key]))),
    });
  }

  svg.style.transformOrigin = '0 0';
  svg.style.willChange = 'transform';
  svg.style.overflow = 'visible';
  canvas.style.overflow = 'hidden';
  svg.setAttribute = function (name, value) {
    if (name !== 'viewBox' || disposed) return originalSetAttribute.call(this, name, value);
    current = String(value);
    const next = current.split(' ').map(Number);
    if (next.length !== 4 || next.some((number) => !Number.isFinite(number)) || next[2] <= 0)
      throw new Error('The compositor prototype requires a finite native camera.');
    const scale = base[2] / next[2];
    const x = ((base[0] - next[0]) * viewport.width) / next[2];
    const y = ((base[1] - next[1]) * viewport.width) / next[2];
    svg.style.transform = `matrix(${scale},0,0,${scale},${x},${y})`;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => flush('idle'), delayMs);
    samples.push({ scale, x, y, desiredViewBox: current });
  };

  // Rebase before domain picking, keyboard commands, export-button activation
  // or a new gesture. Keyup also rebases Home/Fit before the next sample setup.
  const events = ['pointerdown', 'pointerup', 'keydown', 'keyup', 'blur'];
  for (const event of events) window.addEventListener(event, flush, true);
  const cleanup = () => {
    if (disposed) return;
    flush('cleanup');
    disposed = true;
    clearTimeout(timer);
    for (const event of events) window.removeEventListener(event, flush, true);
    if (originalDescriptor) Object.defineProperty(svg, 'setAttribute', originalDescriptor);
    else delete svg.setAttribute;
    if (originalStyle === null) svg.removeAttribute('style');
    else originalSetAttribute.call(svg, 'style', originalStyle);
    if (originalCanvasStyle === null) canvas.removeAttribute('style');
    else canvas.setAttribute('style', originalCanvasStyle);
  };
  window.navigationVariantCleanup = cleanup;
  window.layoutCompositorPrototype = {
    finish() {
      cleanup();
      return {
        samples,
        flushes,
        idleDelayMs: delayMs,
        currentViewBox: svg.getAttribute('viewBox'),
        maximumMatrixError: Math.max(0, ...flushes.map((item) => item.maximumMatrixError)),
        limitations: [
          'The native root viewBox and root bounding rectangle differ during transient CSS motion.',
          'Non-scaling strokes may be raster-scaled during the transient phase; picking is flushed first.',
          'Drawing replacement, resize, annotations and export were not exercised by this navigation diagnostic.',
          'Idle native rebase work is separately reported and is not claimed to disappear.',
        ],
      };
    },
  };
  return {
    name: 'layout-navigation-variant',
    variant: 'compositor-camera',
    before,
    after: geometry(),
    visibleDrawingUnchanged: svg.innerHTML === content,
    scope: 'Diagnostic transient CSS camera; native viewBox rebases after idle and before subsequent picking/commands.',
  };
}
