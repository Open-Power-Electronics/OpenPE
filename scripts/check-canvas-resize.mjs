import assert from 'node:assert/strict';

// Observe the resize delivery itself, before paint. Waiting for a final transform
// would miss a one-frame jump followed by the correct compensated viewport.
export async function watchCanvasResizeFrames(page) {
  await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="schematic-canvas"]');
    const read = () => {
      const { a, d, e, f } = svg.getScreenCTM();
      return { a, d, e, f };
    };
    const state = { before: read(), frames: [] };
    const observer = new ResizeObserver(() => {
      const bounds = svg.getBoundingClientRect();
      if (bounds.width && bounds.height) state.frames.push(read());
    });
    observer.observe(svg);
    window.openpeCanvasResizeCheck = { state, observer };
  });
  return async () => {
    const state = await page.evaluate(() => {
      const { state, observer } = window.openpeCanvasResizeCheck;
      observer.disconnect();
      delete window.openpeCanvasResizeCheck;
      return state;
    });
    assert.ok(state.frames.length >= 2, 'Observe the canvas while its dimensions change.');
    for (const frame of state.frames)
      for (const key of ['a', 'd', 'e', 'f'])
        assert.ok(
          Math.abs(frame[key] - state.before[key]) < 0.01,
          `Canvas ${key} jumped during resize: ${state.before[key]} → ${frame[key]}`,
        );
  };
}
