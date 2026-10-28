import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Two separately bundled module instances exercise the actual HMR registry.
// All DOM/native instrumentation belongs to this isolated fixture.
const bundles = [];
for (const name of ['A', 'B']) {
  const result = await build({
    stdin: {
      contents: `import{hasOpenOverlay}from'./components/openOverlay';window.overlay${name}=hasOpenOverlay;`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
  });
  bundles.push(result.outputFiles[0].text);
}

const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(() => {
    const nativeQuery = Document.prototype.querySelector;
    const NativeObserver = window.MutationObserver;
    const helperObservers = new WeakSet();
    const labels = new WeakMap([[document, 'main']]);
    const stats = { queries: {}, observers: 0, callbacks: {}, observations: [], takes: 0 };
    window.overlayFixture = { nativeQuery, labels, stats };
    Document.prototype.querySelector = function (selector) {
      const label = labels.get(this);
      stats.queries[label] = (stats.queries[label] || 0) + 1;
      return nativeQuery.call(this, selector);
    };
    window.MutationObserver = class extends NativeObserver {
      constructor(callback) {
        super((records, observer) => {
          if (helperObservers.has(observer)) {
            const target = records[0]?.target;
            const label = labels.get(target?.nodeType === 9 ? target : target?.ownerDocument);
            stats.callbacks[label] = (stats.callbacks[label] || 0) + 1;
          }
          callback(records, observer);
        });
      }
      observe(target, options) {
        // Playwright also watches Document childList while injecting scripts.
        // Count the helper's subtree/attribute observers independently of that
        // automation-only observer; still verify its complete options below.
        if (options.subtree && options.attributes) {
          if (!helperObservers.has(this)) {
            helperObservers.add(this);
            stats.observers++;
          }
          stats.observations.push({
            label: labels.get(target),
            document: target.nodeType === 9,
            options: { ...options },
          });
        }
        return super.observe(target, options);
      }
      takeRecords() {
        stats.takes++;
        return super.takeRecords();
      }
    };
  });
  await page.addScriptTag({ content: bundles[0] });
  assert.equal(await page.evaluate(() => window.overlayA()), false);
  assert.deepEqual(
    await page.evaluate(() => ({
      queries: window.overlayFixture.stats.queries.main,
      observers: window.overlayFixture.stats.observers,
    })),
    { queries: 1, observers: 1 },
    JSON.stringify(await page.evaluate(() => window.overlayFixture.stats.observations)),
  );
  // Injecting the replacement script is itself a child-list mutation. The new
  // module must reuse the original observer and invalidate that same state once.
  await page.addScriptTag({ content: bundles[1] });
  const result = await page.evaluate(async () => {
    const selector = 'dialog[open], [role="listbox"], [role="menu"]';
    const { nativeQuery, labels, stats } = window.overlayFixture;
    const checks = [];
    const ensure = (value, message) => {
      if (!value) throw new Error(message);
    };
    const count = (root = document) => stats.queries[labels.get(root)] || 0;
    const oracle = (root) => Boolean(nativeQuery.call(root, selector));
    function check(label, root = document) {
      const expected = oracle(root);
      ensure(window.overlayA(root) === expected, `${label}: module A matches the native selector.`);
      const afterA = count(root);
      ensure(window.overlayB(root) === expected, `${label}: module B matches the native selector.`);
      ensure(count(root) === afterA, `${label}: both module copies share one cached result.`);
      checks.push(label);
      return expected;
    }
    function stable(label, root = document) {
      const before = count(root);
      for (let index = 0; index < 12; index++) check(label, root);
      ensure(count(root) === before, `${label}: unchanged calls do not requery.`);
    }
    function mutate(label, change, root = document) {
      const before = count(root);
      change();
      check(label, root);
      ensure(count(root) === before + 1, `${label}: selector-affecting mutations requery once.`);
    }
    const delivered = () => new Promise((resolve) => setTimeout(resolve, 0));
    check('new module after refresh');
    ensure(
      window.overlayA !== window.overlayB,
      'The bundles expose distinct module function instances.',
    );
    ensure(
      stats.observers === 1 && count() === 2,
      'A replacement bundle shares the existing document observer.',
    );
    ensure(
      window.overlayA() === window.overlayB(),
      'Default Document arguments share the same state.',
    );
    stable('unchanged empty document');

    const nested = document.createElement('section');
    nested.innerHTML = '<div><div role="menu" hidden></div></div>';
    mutate('synchronous nested menu mount', () => document.body.append(nested));
    ensure(oracle(document), 'Hidden overlays preserve the original selector semantics.');
    mutate('synchronous subtree removal', () => nested.remove());
    const list = document.createElement('div');
    mutate('unrelated element mount', () => document.body.append(list));
    mutate('role becomes listbox', () => list.setAttribute('role', 'listbox'));
    mutate('role changes to unrelated value', () => list.setAttribute('role', 'tree'));
    mutate('role becomes menu', () => list.setAttribute('role', 'menu'));
    mutate('role removed', () => list.removeAttribute('role'));

    const dialog = document.createElement('dialog');
    mutate('closed dialog mount', () => document.body.append(dialog));
    mutate('dialog open property', () => {
      dialog.open = true;
    });
    mutate('dialog close property', () => {
      dialog.open = false;
    });
    mutate('dialog native show', () => dialog.show());
    mutate('dialog native close', () => dialog.close());
    mutate('dialog native showModal', () => dialog.showModal());
    mutate('modal native close', () => dialog.close());
    mutate('boolean open attribute value', () => dialog.setAttribute('open', 'false'));
    ensure(oracle(document), 'The open attribute is matched independently of its string value.');
    mutate('open attribute removed', () => dialog.removeAttribute('open'));
    mutate('multiple overlays coexist', () => {
      dialog.open = true;
      list.setAttribute('role', 'menu');
    });
    mutate('closing one overlay retains the other', () => {
      dialog.open = false;
    });
    ensure(oracle(document), 'Closing one overlay cannot clear another matching element.');
    mutate('last coexisting overlay closes', () => list.removeAttribute('role'));

    const eventTarget = document.createElement('button');
    mutate('event target mount', () => document.body.append(eventTarget));
    let eventChecks = 0;
    eventTarget.addEventListener('click', () => {
      stable('same-event stable calls before mount');
      mutate('same-event menu insertion', () => {
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        eventTarget.append(menu);
      });
      stable('same-event stable calls while open');
      mutate('same-event menu removal', () => eventTarget.replaceChildren());
      stable('same-event stable calls after removal');
      eventChecks++;
    });
    eventTarget.click();
    ensure(eventChecks === 1, 'All repeated reads occur inside one real dispatched event.');

    const callbackBefore = stats.callbacks.main || 0;
    const queryBeforeCallback = count();
    list.setAttribute('role', 'listbox');
    await delivered();
    ensure(
      (stats.callbacks.main || 0) > callbackBefore,
      'The fixture exercises a delivered observer callback.',
    );
    check('observer-delivered role change');
    ensure(count() === queryBeforeCallback + 1, 'A delivered callback invalidates the cache once.');
    stable('stable after observer delivery');
    mutate('close delivered listbox', () => list.removeAttribute('role'));
    await delivered();
    stable('drained synchronous records do not invalidate again');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const group = document.createElementNS(svg.namespaceURI, 'g');
    const shapes = [];
    for (let index = 0; index < 2048; index++) {
      const rect = document.createElementNS(svg.namespaceURI, 'rect');
      rect.setAttribute('x', String(index));
      group.append(rect);
      shapes.push(rect);
    }
    const text = document.createElementNS(svg.namespaceURI, 'text');
    const characters = document.createTextNode('before');
    text.append(characters);
    svg.append(group, text);
    mutate('large SVG subtree mount', () => document.body.append(svg));
    const beforeGeometry = count();
    const callbacksBeforeGeometry = stats.callbacks.main || 0;
    for (let index = 0; index < shapes.length; index++) {
      shapes[index].setAttribute('x', String(index + 1));
      shapes[index].setAttribute('width', '7');
      shapes[index].setAttribute('transform', 'translate(2 3)');
    }
    svg.setAttribute('viewBox', '10 20 300 200');
    svg.setAttribute('class', 'panning');
    svg.style.cursor = 'grabbing';
    characters.data = 'after';
    check('same-stack camera geometry and character data');
    await delivered();
    stable('camera geometry and character data after delivery');
    ensure(count() === beforeGeometry, 'Camera/geometry/style/class/characterData do not requery.');
    ensure(
      (stats.callbacks.main || 0) === callbacksBeforeGeometry,
      'Unrelated attributes and character data are not observed.',
    );
    mutate('textContent child-list replacement', () => {
      text.textContent = 'replacement';
    });
    mutate('batch SVG child-list change', () => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 512; index++)
        fragment.append(document.createElementNS(svg.namespaceURI, 'path'));
      group.append(fragment);
    });
    mutate('role attribute on SVG', () => group.setAttribute('role', 'menu'));
    mutate('SVG role removed', () => group.removeAttribute('role'));

    const other = document.implementation.createHTMLDocument('Other document');
    labels.set(other, 'other');
    check('independent Document initial state', other);
    ensure(
      stats.observers === 2 && count(other) === 1,
      'Each Document receives exactly one observer.',
    );
    const mainBeforeOther = count();
    const otherMenu = other.createElement('div');
    otherMenu.setAttribute('role', 'menu');
    mutate('independent Document menu insertion', () => other.body.append(otherMenu), other);
    stable('other Document leaves main cache untouched');
    ensure(count() === mainBeforeOther, 'Another Document cannot invalidate the main cache.');
    mutate('main Document overlay while other stays open', () =>
      list.setAttribute('role', 'listbox'),
    );
    const otherBeforeMain = count(other);
    check('other Document retains its own open state', other);
    ensure(
      count(other) === otherBeforeMain,
      'Main-document changes leave the other cached result intact.',
    );
    mutate('main overlay closes independently', () => list.removeAttribute('role'));
    mutate('other overlay closes independently', () => otherMenu.remove(), other);
    ensure(
      !oracle(document) && !oracle(other),
      'Both Documents can return to independent closed states.',
    );

    const replacement = document.createElement('body');
    const replacementDialog = document.createElement('dialog');
    replacementDialog.open = true;
    replacement.append(replacementDialog);
    mutate('entire body replacement containing overlay', () =>
      document.body.replaceWith(replacement),
    );
    mutate('replacement body dialog closes', () => {
      replacementDialog.open = false;
    });
    mutate('replacement body nested content becomes overlay', () => {
      replacement.innerHTML = '<section><div role="listbox"></div></section>';
    });
    mutate('replacement body content removed', () => replacement.replaceChildren());
    await delivered();
    stable('stable after entire-body replacement');

    ensure(
      stats.observations.length === 2,
      'Module refresh does not observe the same Document again.',
    );
    for (const observation of stats.observations) {
      const options = observation.options;
      ensure(
        observation.document && options.childList && options.subtree && options.attributes,
        'Observers cover their Document subtree.',
      );
      ensure(!options.characterData, 'Observers exclude character data.');
      ensure(
        [...options.attributeFilter].sort().join(',') === 'open,role',
        'Only selector-affecting attributes are observed.',
      );
    }
    return {
      checks: checks.length,
      observers: stats.observers,
      queries: stats.queries,
      callbacks: stats.callbacks,
      takes: stats.takes,
    };
  });
  assert.deepEqual(errors, []);
  assert.equal(result.observers, 2);
  assert.ok(result.checks > 100 && result.queries.main > 20 && result.queries.other === 3);
  console.log(
    `Overlay query equivalence verified: ${result.checks} reads, two module copies share one observer per Document; synchronous mutations, callbacks, body replacement and SVG batches remain exact, while stable camera/geometry/characterData updates do not requery.`,
  );
} finally {
  await browser.close();
}
