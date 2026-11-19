import { readCatalogBytes } from './online-library-fetch.mjs';

const endpoint = 'https://www.hqonline.com/api/goods/products/search';
const pageSize = 50;
const maxPages = 4;
const maxOffers = 4;
export const pricingPartNumber = (value) =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';
const invalidResponse = () => new Error('HQ Online returned an invalid pricing response.');
const manufacturerLabels = new Map([
  ['TEXAS INSTRUMENTS', 'TI'],
  ['TEXAS INSTRUMENTS (TI)', 'TI'],
  ['STMICROELECTRONICS', 'ST'],
  ['ANALOG DEVICES', 'ADI'],
  ['ON SEMICONDUCTOR', 'ON'],
  ['MICROCHIP TECHNOLOGY', 'MICROCHIP'],
]);

function manufacturerKey(value) {
  const label = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return manufacturerLabels.get(label) ?? label;
}

async function readPricePage(fetcher, keyword, current, signal) {
  const bytes = await readCatalogBytes(
    'HQ Online',
    fetcher,
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ keyword, current, size: pageSize }),
    },
    512 * 1024,
    signal,
  );
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidResponse();
  }
  const result = data?.result;
  if (
    data?.retCode !== 200 ||
    result?.current !== current ||
    result.size !== pageSize ||
    !Number.isSafeInteger(result.pages) ||
    result.pages < 0 ||
    !Array.isArray(result.records) ||
    result.records.length > pageSize ||
    (current > result.pages && result.records.length)
  )
    throw invalidResponse();
  return result;
}

export function readHqOnlineOffer(row) {
  if (
    typeof row.goodsNo !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(row.goodsNo) ||
    !Number.isSafeInteger(row.goodsId) ||
    row.goodsId <= 0 ||
    !Array.isArray(row.price) ||
    row.price.length > 32
  )
    throw invalidResponse();
  if (!row.price.length) return null;
  const quantities = new Set();
  const tiers = row.price.map((tier) => {
    const quantity = tier?.purchases;
    const unitPrice = tier?.unitPrice;
    if (
      String(tier?.goodsId) !== String(row.goodsId) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      quantities.has(quantity) ||
      !Number.isFinite(unitPrice) ||
      unitPrice <= 0 ||
      unitPrice > 1_000_000_000
    )
      throw invalidResponse();
    quantities.add(quantity);
    return { quantity, unitPrice };
  });
  const manufacturer = [row.brandName, row.pinyin?.brandName]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .find((value) => value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value));
  return {
    sku: row.goodsNo,
    manufacturer: manufacturer ?? null,
    tiers: tiers.sort((a, b) => a.quantity - b.quantity),
    ...(Number.isSafeInteger(row.spotNumber) && row.spotNumber >= 0
      ? { stock: row.spotNumber }
      : {}),
  };
}

export async function readNextpcbPrices(fetcher, { name, manufacturer }, signal) {
  const partNumber = pricingPartNumber(name);
  if (!partNumber) throw new Error('NextPCB did not supply a part number for pricing.');
  const brand = manufacturerKey(manufacturer);

  const preferred = [];
  const other = [];
  const skus = new Set();
  let invalidOffer;
  let pages = 1;
  for (let current = 1; current <= Math.min(pages, maxPages); current++) {
    const result = await readPricePage(fetcher, name, current, signal);
    pages = result.pages;
    for (const row of result.records) {
      if (pricingPartNumber(row?.goodsName) !== partNumber || skus.has(row.goodsNo)) continue;
      const sameManufacturer =
        brand &&
        [row.brandName, row.pinyin?.brandName].some((label) => manufacturerKey(label) === brand);
      const group = sameManufacturer ? preferred : other;
      if (group.length === maxOffers) continue;
      let offer;
      try {
        offer = readHqOnlineOffer(row);
      } catch (error) {
        invalidOffer ??= error;
        continue;
      }
      if (!offer) continue;
      skus.add(offer.sku);
      group.push(offer);
      if (preferred.length === maxOffers || (!brand && other.length === maxOffers)) break;
    }
    if (preferred.length === maxOffers || (!brand && other.length === maxOffers)) break;
  }
  const offers = [...preferred, ...other].slice(0, maxOffers);
  if (!offers.length) {
    if (invalidOffer) throw invalidOffer;
    if (pages > maxPages)
      throw new Error('HQ Online pricing search exceeded the supported page limit.');
  }
  return { currency: 'USD', checkedAt: Date.now(), offers };
}
