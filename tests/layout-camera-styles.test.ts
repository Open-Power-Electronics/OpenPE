import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLayoutCameraStyle } from '../components/layoutCameraStyles';

function withResolvedStyle(run: (reads: { count: number }) => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  const reads = { count: 0 };
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: () => {
      reads.count++;
      return { getPropertyValue: (name: string) => (name === 'zoom' ? '1' : 'none') };
    },
  });
  try {
    run(reads);
  } finally {
    if (original) Object.defineProperty(globalThis, 'getComputedStyle', original);
    else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
}

test('camera style checks use computed values without requesting resolved transforms', () => {
  withResolvedStyle((reads) => {
    const values = { transform: 'matrix(2, 0, 0, 2, 1, 3)', translate: 'none', zoom: '1' };
    const element = {
      computedStyleMap: () => new Map(Object.entries(values)),
    } as unknown as Element;
    const read = readLayoutCameraStyle(element);
    assert.equal(read('transform'), values.transform);
    assert.equal(read('translate'), 'none');
    assert.equal(read('zoom'), '1');
    assert.equal(reads.count, 0);
  });
});

test('a new camera check observes current stylesheet or animation values', () => {
  withResolvedStyle((reads) => {
    let transform = 'none';
    const element = {
      computedStyleMap: () => new Map([['transform', transform]]),
      style: { transform: 'matrix(2, 0, 0, 2, 0, 0)' },
    } as unknown as Element;
    assert.equal(readLayoutCameraStyle(element)('transform'), 'none');
    transform = 'matrix(0, 1, -1, 0, 0, 0)';
    assert.equal(readLayoutCameraStyle(element)('transform'), transform);
    assert.equal(reads.count, 0);
  });
});

test('missing Typed OM resolves properties lazily and shares only the current declaration', () => {
  withResolvedStyle((reads) => {
    const read = readLayoutCameraStyle({} as Element);
    assert.equal(reads.count, 0);
    assert.equal(read('transform'), 'none');
    assert.equal(read('zoom'), '1');
    assert.equal(reads.count, 1);
    assert.equal(readLayoutCameraStyle({} as Element)('transform'), 'none');
    assert.equal(reads.count, 2);
  });
});

test('throwing or partial Typed OM retains per-property fallback', () => {
  withResolvedStyle((reads) => {
    const unsupported = {
      computedStyleMap: () => {
        throw new Error('Typed OM unavailable');
      },
    } as unknown as Element;
    assert.equal(readLayoutCameraStyle(unsupported)('transform'), 'none');
    const partial = {
      computedStyleMap: () => ({
        get: (name: string) => {
          if (name === 'transform') throw new Error('Unsupported property');
          return name === 'zoom' ? '100%' : undefined;
        },
      }),
    } as unknown as Element;
    const read = readLayoutCameraStyle(partial);
    assert.equal(read('transform'), 'none');
    assert.equal(read('zoom'), '100%');
    assert.equal(read('perspective'), 'none');
    assert.equal(reads.count, 2);
  });
});

test('empty or failed serialization uses the resolved fallback', () => {
  withResolvedStyle((reads) => {
    const element = {
      computedStyleMap: () => ({
        get: (name: string) => {
          if (name === 'transform') return { toString: () => '' };
          if (name === 'translate') return null;
          return {
            toString: () => {
              throw new Error('Cannot serialize');
            },
          };
        },
      }),
    } as unknown as Element;
    const read = readLayoutCameraStyle(element);
    assert.equal(read('transform'), 'none');
    assert.equal(read('translate'), 'none');
    assert.equal(read('zoom'), '1');
    assert.equal(reads.count, 1);
  });
});

test('foreign and percentage transforms remain intact for the camera eligibility guard', () => {
  withResolvedStyle((reads) => {
    const values = {
      transform: 'translate(50%, 0px)',
      translate: '10%',
      rotate: '0deg',
      scale: '1',
      perspective: '10px',
      zoom: '100%',
    };
    const element = {
      computedStyleMap: () => new Map(Object.entries(values)),
    } as unknown as Element;
    const read = readLayoutCameraStyle(element);
    for (const [name, value] of Object.entries(values)) assert.equal(read(name), value);
    assert.equal(reads.count, 0);
  });
});
