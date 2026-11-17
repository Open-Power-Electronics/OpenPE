import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preferredQuantityUnit,
  quantityUnitFromLabel,
  quantityUnits,
  readQuantity,
} from '../components/quantity-units';

test('engineering inputs convert compatible units without accepting unrelated dimensions', () => {
  assert.ok(Math.abs(readQuantity('438.59 µs', 's') - 0.00043859) <= Number.EPSILON * 0.00043859);
  assert.equal(readQuantity('1 ms', 'µs'), 1000);
  assert.equal(readQuantity('1 in', 'mm'), 25.4);
  assert.ok(Math.abs(readQuantity('300 K', '°C') - 26.85) < 1e-10);
  assert.ok(Math.abs(readQuantity('3.141592653589793 rad', '°') - 180) < 1e-10);
  assert.equal(readQuantity('2 kW/m²·K', 'W/m²·K'), 2000);
  assert.ok(Number.isNaN(readQuantity('2 V', 's')));
  for (const invalid of ['', '-', '1e+', '0x10', 'Infinity'])
    assert.ok(Number.isNaN(readQuantity(invalid, 's')));
});

test('native SPICE parameter prefixes display as separate compatible units', () => {
  assert.ok(Math.abs(readQuantity('5u', 's') - 0.000005) <= Number.EPSILON * 0.000005);
  assert.equal(preferredQuantityUnit('5u', 's'), 'µs');
  assert.equal(preferredQuantityUnit('0.000438592396388', 's'), 'µs');
  assert.equal(preferredQuantityUnit('0', 's'), 's');
  assert.equal(quantityUnitFromLabel('Via diameter (mm)'), 'mm');
  assert.equal(quantityUnitFromLabel('Component name'), undefined);
  assert.ok(quantityUnits('V').every((entry) => entry.label.endsWith('V')));
});
