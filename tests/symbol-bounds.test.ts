import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExample } from '../lib/examples';
import { symbolBodyBounds } from '../lib/symbol-bounds';
import { parseSExpr } from '../lib/sexpr';

test('Rectifier D1 and C1 body targets do not overlap even when C1 is painted last', () => {
  const d = createExample('kicad-rectifier').schematic;
  const before = JSON.stringify(d);
  const diode = d.parts.find((p) => p.ref === 'D1')!,
    capacitor = d.parts.find((p) => p.ref === 'C1')!;
  // Reproduce the old 19 x 20 mm region swallowing the visible diode.
  assert.ok(
    diode.x >= capacitor.x - 9 &&
      diode.x <= capacitor.x + 10 &&
      diode.y >= capacitor.y - 10 &&
      diode.y <= capacitor.y + 10,
  );
  const contains = (p: typeof diode, x: number, y: number) => {
    const bounds = symbolBodyBounds(d.libraries[p.libId], p.unit)!;
    const angle = (p.rotation * Math.PI) / 180;
    const dx = (x - p.x) * (p.mirror === 'y' ? -1 : 1),
      dy = (y - p.y) * (p.mirror === 'x' ? -1 : 1);
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle),
      localY = dx * Math.sin(angle) + dy * Math.cos(angle);
    return (
      localX >= bounds.x - 0.5 &&
      localX <= bounds.x + bounds.width + 0.5 &&
      localY >= bounds.y - 0.5 &&
      localY <= bounds.y + bounds.height + 0.5
    );
  };
  for (const parts of [d.parts, [...d.parts].reverse()]) {
    for (const target of [diode, capacitor])
      assert.deepEqual(
        parts.filter((p) => contains(p, target.x, target.y)).map((p) => p.ref),
        [target.ref],
      );
    // The diode triangle remains clickable on either side of its centre.
    for (const dx of [-0.5, 0.5])
      assert.deepEqual(
        parts.filter((p) => contains(p, diode.x + dx, diode.y - 0.25)).map((p) => p.ref),
        ['D1'],
      );
  }
  assert.equal(JSON.stringify(d), before, 'hit bounds do not alter the circuit');
});

test('body bounds ignore long pins/text and other units, and do not invent boxes for pin-only symbols', () => {
  const library = parseSExpr(`(symbol "Test" (symbol "Test_0_1" (circle (center 0 0) (radius 1)))
    (symbol "Test_1_1" (rectangle (start -2 3) (end 2 -3)) (pin passive line (at -100 0 0) (length 98)) (text "very long pin name" (at 100 100 0)))
    (symbol "Test_2_1" (rectangle (start -20 30) (end 20 -30)))
    (symbol "Test_1_2" (circle (center 0 0) (radius 999))))`);
  assert.deepEqual(symbolBodyBounds(library, 1), { x: -2, y: -3, width: 4, height: 6 });
  assert.deepEqual(symbolBodyBounds(library, 2), { x: -20, y: -30, width: 40, height: 60 });
  assert.equal(
    symbolBodyBounds(
      parseSExpr('(symbol "Pin" (symbol "Pin_1_1" (pin passive line (at 0 0 0) (length 2))))'),
    ),
    null,
  );
});

test('arc body bounds include swept extrema without expanding to the full circle', () => {
  // Upper semicircle, with the midpoint away from the top-most extremum.
  const library = parseSExpr(
    '(symbol "Arc" (symbol "Arc_1_1" (arc (start 1 0) (mid 0.6 0.8) (end -1 0))))',
  );
  const bounds = symbolBodyBounds(library)!;
  assert.ok(Math.abs(bounds.x + 1) < 1e-8 && Math.abs(bounds.y + 1) < 1e-8);
  assert.ok(Math.abs(bounds.width - 2) < 1e-8 && Math.abs(bounds.height - 1) < 1e-8);
});
