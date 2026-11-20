import { readCatalogBytes } from './online-library-fetch.mjs';
import { isLibraryPriceSource, propertyValue } from './library-format.mjs';

const lcscEndpoint = 'https://wmsc.lcsc.com/ftps/wm/product/query/list';
const lcscSkuPattern = /^C[1-9]\d{0,11}$/;
const maxOffers = 4;
const tiLm2596Datasheet = 'http://www.ti.com/lit/ds/symlink/lm2596.pdf';
const reviewedOrderNumbers = new Map([
  ['Regulator_Switching:LM2596S-5', 'LM2596S-5.0/NOPB'],
  ['Regulator_Switching:LM2596T-5', 'LM2596T-5.0/NOPB'],
]);

export function isLibraryPriceRequest(input) {
  return (
    input &&
    typeof input === 'object' &&
    Object.keys(input).length === 3 &&
    typeof input.id === 'string' &&
    input.id.length <= 500 &&
    /^[^:\u0000-\u001f\u007f]+:[^\u0000-\u001f\u007f]+$/.test(input.id) &&
    ['symbols', 'footprints'].includes(input.kind) &&
    isLibraryPriceSource(input.source)
  );
}

function priceIdentityText(value) {
  return typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : '';
}

export function kiCadPricePart({ id, name, symbol }) {
  const mpn = priceIdentityText(
    propertyValue(symbol, 'Manufacturer Part Number') || propertyValue(symbol, 'MPN'),
  );
  const manufacturer = priceIdentityText(propertyValue(symbol, 'Manufacturer'));
  const orderNumber = reviewedOrderNumbers.get(id);
  if (
    !mpn &&
    !manufacturer &&
    orderNumber &&
    propertyValue(symbol, 'Datasheet') === tiLm2596Datasheet
  )
    return { mpn: orderNumber, manufacturer: 'Texas Instruments (TI)' };
  return { mpn: mpn || (/\d/.test(name) ? priceIdentityText(name) : ''), manufacturer };
}

function manufacturerNames(value) {
  const alias = /^(.+)\s+\(([A-Z][A-Z0-9]{1,9})\)$/.exec(value);
  return (alias ? [alias[1], alias[2]] : [value])
    .map((name) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
}

export function matchesPricePart(part, mpn, manufacturer) {
  if (priceIdentityText(mpn).toUpperCase() !== part.mpn.toUpperCase()) return false;
  if (!part.manufacturer) return true;
  const names = manufacturerNames(priceIdentityText(manufacturer));
  return manufacturerNames(part.manufacturer).some((name) => names.includes(name));
}

function invalidPrices(provider) {
  return new Error(`${provider} returned an invalid pricing response.`);
}

async function readJson(provider, fetcher, url, options, signal) {
  let bytes;
  try {
    bytes = await readCatalogBytes(
      provider,
      fetcher,
      url,
      { ...options, cache: 'no-store' },
      1024 * 1024,
      signal,
    );
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted)
      throw new Error(`${provider} price request failed. Check your connection and retry.`);
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidPrices(provider);
  }
}

function readOffer(
  provider,
  { productCode: sku, brandNameEn: manufacturer, stockNumber: stock, productPriceList: prices },
) {
  if (prices === null) return null;
  if (!Array.isArray(prices) || prices.length > 32) throw invalidPrices(provider);
  const tiers = new Map();
  for (const price of prices) {
    const quantity = price?.ladder;
    const unitPrice = price?.usdPrice;
    if (unitPrice === null) continue;
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(unitPrice) ||
      unitPrice <= 0 ||
      unitPrice > 1_000_000_000 ||
      tiers.has(quantity)
    )
      throw invalidPrices(provider);
    tiers.set(quantity, { quantity, unitPrice });
  }
  if (!tiers.size) return null;
  if (typeof sku !== 'string' || !lcscSkuPattern.test(sku)) throw invalidPrices(provider);
  return {
    sku,
    manufacturer: priceIdentityText(manufacturer) || null,
    ...(Number.isSafeInteger(stock) && stock >= 0 ? { stock } : {}),
    tiers: [...tiers.values()].sort((a, b) => a.quantity - b.quantity),
  };
}

function distinctOffers(offers) {
  return [...new Map(offers.filter(Boolean).map((offer) => [offer.sku, offer])).values()].slice(
    0,
    maxOffers,
  );
}

export async function readLcscPrices(fetcher, part, signal) {
  const provider = 'LCSC';
  const response = await readJson(
    provider,
    fetcher,
    lcscEndpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keyword: part.lcscSku ?? part.mpn, currentPage: 1, pageSize: 25 }),
    },
    signal,
  );
  const rows = response?.result?.dataList;
  if (response?.code !== 200 || !Array.isArray(rows) || rows.length > 25)
    throw invalidPrices(provider);
  return distinctOffers(
    rows
      .filter((row) =>
        part.lcscSku
          ? row?.productCode === part.lcscSku
          : matchesPricePart(part, row?.productModel, row?.brandNameEn),
      )
      .map((row) => readOffer(provider, row)),
  );
}
