// Playwright's browser-side truthiness poll does not retry a Promise that later
// resolves false. Await async conditions in the test process before deciding.
export async function waitForAsync(page, predicate, arg, { timeout = 30000, polling = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Async browser condition timed out after ${timeout} ms.`);
    let timer;
    const value = await Promise.race([
      page.evaluate(predicate, arg),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Async browser condition timed out after ${timeout} ms.`)),
          remaining,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (value) return value;
    await page.waitForTimeout(Math.min(polling, Math.max(0, deadline - Date.now())));
  }
}
