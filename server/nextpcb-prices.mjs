import { readCatalogBytes } from './online-library-fetch.mjs';

const endpoint = 'https://library.nextpcb.com/api/chiplet/kicad/searchSupplyChain';
const manufacturerIdPattern = /^[1-9]\d{0,18}$/;
const maxOffers = 4;
export const nextpcbSupplyBatchLimit = 50;
const invalidResponse = () =>
  new Error('Huaqiu returned an invalid supply-chain pricing response.');

function supplyKey(manufacturerId, mpn) {
  if (
    typeof manufacturerId !== 'string' ||
    !manufacturerIdPattern.test(manufacturerId) ||
    typeof mpn !== 'string' ||
    !mpn.trim() ||
    mpn.length > 200 ||
    /[\u0000-\u001f]/.test(mpn)
  )
    return '';
  return manufacturerId + '-' + mpn;
}

function readUsdOffer(row) {
  if (row.price === null) return null;
  if (!Array.isArray(row.price) || row.price.length > 32) throw invalidResponse();
  const quantities = new Set();
  const tiers = [];
  for (const tier of row.price) {
    if (!tier || !Object.hasOwn(tier, 'usd')) throw invalidResponse();
    if (tier.usd === null) continue;
    if (
      !Number.isSafeInteger(tier.breakMin) ||
      tier.breakMin <= 0 ||
      quantities.has(tier.breakMin) ||
      !Number.isFinite(tier.usd) ||
      tier.usd <= 0 ||
      tier.usd > 1_000_000_000
    )
      throw invalidResponse();
    quantities.add(tier.breakMin);
    tiers.push({ quantity: tier.breakMin, unitPrice: tier.usd });
  }
  if (!tiers.length) return null;
  if (typeof row.sku !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.sku))
    throw invalidResponse();
  return {
    sku: row.sku,
    manufacturer: null,
    tiers: tiers.sort((a, b) => a.quantity - b.quantity),
    ...(Number.isSafeInteger(row.stock) && row.stock >= 0 ? { stock: row.stock } : {}),
  };
}

/**
 * @param {typeof fetch} fetcher
 * @param {{manufacturer_id: string, mpn: string}[]} parts
 * @param {AbortSignal} signal
 */
export async function readNextpcbSupplyPrices(fetcher, parts, signal) {
  if (!Array.isArray(parts) || !parts.length || parts.length > nextpcbSupplyBatchLimit)
    throw new Error('Invalid Huaqiu pricing batch size.');
  const requests = new Map();
  for (const part of parts) {
    const key = supplyKey(part?.manufacturer_id, part?.mpn);
    if (!key || requests.has(key))
      throw new Error('Invalid or duplicate NextPCB pricing identity.');
    requests.set(key, { offers: new Map(), invalid: false });
  }

  const bytes = await readCatalogBytes(
    'Huaqiu supply chain',
    fetcher,
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify([...requests.keys()]),
    },
    1024 * 1024,
    signal,
  );
  let response;
  try {
    response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidResponse();
  }
  if (
    response?.code !== 200000 ||
    !Array.isArray(response.result) ||
    response.result.length > parts.length * 32
  )
    throw invalidResponse();

  for (const row of response.result) {
    const manufacturerId = Number.isSafeInteger(row?.mfgId) ? String(row.mfgId) : row?.mfgId;
    const key = supplyKey(manufacturerId, row?.mpn);
    if (!key || typeof row.vendor !== 'string') throw invalidResponse();
    const request = requests.get(key);
    if (!request || row.vendor !== 'hqself' || request.offers.size >= maxOffers) continue;
    try {
      const offer = readUsdOffer(row);
      if (offer && !request.offers.has(offer.sku)) request.offers.set(offer.sku, offer);
    } catch {
      request.invalid = true;
    }
  }
  const checkedAt = Date.now();
  return [...requests.values()].map(({ offers, invalid }) => ({
    quote: { currency: 'USD', checkedAt, offers: [...offers.values()] },
    ...(invalid && !offers.size ? { error: invalidResponse().message } : {}),
  }));
}
