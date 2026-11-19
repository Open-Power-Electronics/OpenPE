import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { libraryPriceSources } from '../lib/library';
import { createLibraryService } from '../server/libraries.mjs';

test('all three catalogs use each selected price source through host-resolved part identities', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-price-sources-'));
  const kiCadId = 'Regulator_Switching:LM2596S-5';
  const nextId = 'NextPCB:9728_LM2596S-5.0%2FNOPB';
  const jlcId = 'JLCPCB:C123';
  const calls: string[] = [];
  const nextpcbFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/productDetail')) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        manufacturer_id: '9728',
        mpn: 'LM2596S-5.0/NOPB',
      });
      return Response.json({
        code: 200000,
        result: { mfgId: 9728, mpn: 'LM2596S-5.0/NOPB', mfg: 'Texas Instruments (TI)' },
      });
    }
    if (url.endsWith('/queryPage')) {
      assert.equal(JSON.parse(String(init?.body)).desc, 'LM2596S-5.0/NOPB');
      return Response.json({
        code: 200000,
        total: 3,
        result: [
          {
            manufacturer_id: '9728',
            mpn: 'LM2596S-5.0/NOPB',
            manufacturer: 'Texas Instruments (TI)',
          },
          {
            manufacturer_id: '123',
            mpn: 'LM2596T-5.0/NOPB',
            manufacturer: 'Texas Instruments (TI)',
          },
          {
            manufacturer_id: '124',
            mpn: 'LM2596S-5.0/NOPB',
            manufacturer: 'Different manufacturer',
          },
        ],
      });
    }
    assert.equal(url, 'https://library.nextpcb.com/api/chiplet/kicad/searchSupplyChain');
    assert.deepEqual(JSON.parse(String(init?.body)), ['9728-LM2596S-5.0/NOPB']);
    calls.push('huaqiu');
    return Response.json({
      code: 200000,
      result: [
        {
          mfgId: 9728,
          mpn: 'LM2596S-5.0/NOPB',
          vendor: 'hqself',
          sku: 'HQ1',
          stock: 8,
          price: [{ breakMin: 1, usd: 0.25 }],
        },
      ],
    });
  };
  const jlcpcbFetcher: typeof fetch = async (input, init) => {
    assert.match(String(input), /^https:\/\/jlcpcb\.com\//);
    assert.equal(JSON.parse(String(init?.body)).keyword, 'C123');
    return Response.json({
      code: 200,
      data: {
        componentPageInfo: {
          total: 1,
          pageNum: 1,
          pageSize: 100,
          list: [
            { componentCode: 'C123', componentModelEn: 'LM2596S-5.0/NOPB', componentBrandEn: 'TI' },
          ],
        },
      },
    });
  };
  const priceFetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
    assert.ok(init?.signal);
    if (url === 'https://wmsc.lcsc.com/ftps/wm/product/query/list') {
      const { keyword } = JSON.parse(String(init?.body));
      calls.push(`lcsc:${keyword}`);
      const row = {
        productCode: 'C123',
        productModel: 'LM2596S-5.0/NOPB',
        brandNameEn: 'Texas Instruments (TI)',
        stockNumber: 7,
        productPriceList: [{ ladder: 1, usdPrice: 0.25 }],
      };
      return Response.json({
        code: 200,
        result: {
          dataList: [
            { ...row, productCode: 'C1234', productModel: 'LM2596T-5.0/NOPB' },
            { ...row, productCode: 'C4321', brandNameEn: 'Different manufacturer' },
            row,
          ],
        },
      });
    }
    assert.fail('Unexpected price request: ' + url);
  };
  const libraries = createLibraryService({
    root,
    nextpcbFetcher,
    jlcpcbFetcher,
    priceFetcher,
  });
  try {
    await mkdir(path.join(root, 'symbols'));
    await mkdir(path.join(root, 'footprints'));
    await writeFile(
      path.join(root, 'symbols', 'Regulator_Switching.kicad_sym'),
      '(kicad_symbol_lib (version 20241209) (symbol "LM2596S-5" (property "Reference" "U") (property "Value" "LM2596S-5") (property "Datasheet" "http://www.ti.com/lit/ds/symlink/lm2596.pdf")))',
    );
    const expectedSku = { lcsc: 'C123', huaqiu: 'HQ1' };
    for (const id of [kiCadId, nextId, jlcId]) {
      for (const source of libraryPriceSources) {
        const quote = await libraries.price({ id, kind: 'symbols', source });
        assert.equal(quote.source, source);
        assert.equal(quote.currency, 'USD');
        assert.deepEqual(
          quote.offers.map((offer) => offer.sku),
          [expectedSku[source]],
        );
        assert.deepEqual(quote.offers[0].tiers, [{ quantity: 1, unitPrice: 0.25 }]);
      }
    }
    assert.deepEqual(calls, [
      'lcsc:LM2596S-5.0/NOPB',
      'huaqiu',
      'lcsc:LM2596S-5.0/NOPB',
      'huaqiu',
      'lcsc:C123',
      'huaqiu',
    ]);
    await assert.rejects(libraries.price({ id: kiCadId, kind: 'symbols', source: 'unknown' }));
    await assert.rejects(
      libraries.price({ id: kiCadId, kind: 'symbols', source: 'lcsc' }, AbortSignal.abort()),
    );
    assert.equal(calls.length, 6);
  } finally {
    libraries.close();
    await rm(root, { recursive: true, force: true });
  }
});
