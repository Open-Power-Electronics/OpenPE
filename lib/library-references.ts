import { api } from './bridge';
import type { LibraryDatasheetSource, LibraryPrice, LibraryPriceSource } from './library';

type LibraryKind = 'symbols' | 'footprints';

function isLibraryPrice(value: unknown, source: LibraryPriceSource): value is LibraryPrice {
  const quote = value as Partial<LibraryPrice> | null;
  return (
    quote?.source === source &&
    quote.currency === 'USD' &&
    typeof quote.checkedAt === 'number' &&
    Number.isSafeInteger(quote.checkedAt) &&
    quote.checkedAt > 0 &&
    quote.checkedAt <= 8.64e15 &&
    Array.isArray(quote.offers) &&
    quote.offers.length <= 4 &&
    quote.offers.every(
      (offer) =>
        offer &&
        typeof offer.sku === 'string' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(offer.sku) &&
        (offer.manufacturer === null ||
          (typeof offer.manufacturer === 'string' &&
            offer.manufacturer.trim().length > 0 &&
            offer.manufacturer.length <= 200)) &&
        (offer.stock === undefined || (Number.isSafeInteger(offer.stock) && offer.stock >= 0)) &&
        Array.isArray(offer.tiers) &&
        offer.tiers.length > 0 &&
        offer.tiers.length <= 32 &&
        offer.tiers.every(
          (tier: LibraryPrice['offers'][number]['tiers'][number]) =>
            tier &&
            Number.isSafeInteger(tier.quantity) &&
            tier.quantity > 0 &&
            Number.isFinite(tier.unitPrice) &&
            tier.unitPrice > 0,
        ),
    )
  );
}

export type DatasheetPage = {
  page: number;
  pageCount: number;
  image: { mimeType: 'image/png'; data: string; width: number; height: number };
};

function isDatasheetPage(value: unknown, page: number): value is DatasheetPage {
  const result = value as DatasheetPage | null;
  const image = result?.image;
  return (
    result?.page === page &&
    Number.isInteger(result.pageCount) &&
    result.pageCount >= page &&
    result.pageCount <= 10_000 &&
    image?.mimeType === 'image/png' &&
    Number.isInteger(image.width) &&
    image.width >= 1 &&
    image.width <= 2400 &&
    Number.isInteger(image.height) &&
    image.height >= 1 &&
    image.height <= 2400 &&
    typeof image.data === 'string' &&
    image.data.length <= Math.ceil((8 * 1024 * 1024) / 3) * 4 &&
    image.data.startsWith('iVBORw0KGgo')
  );
}

export async function readLibraryPrice(
  input: { id: string; kind: LibraryKind; source: LibraryPriceSource },
  signal: AbortSignal,
): Promise<LibraryPrice> {
  const query = new URLSearchParams(input);
  const response = await api(`library-price?${query}`, { signal, cache: 'no-store' });
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json')
    throw Object.assign(new Error('The price service is unavailable.'), {
      code: 'LIBRARY_PRICE_SERVICE',
    });
  const value: unknown = await response.json();
  signal.throwIfAborted();
  if (!isLibraryPrice(value, input.source)) throw new Error('Invalid library price quote.');
  return value;
}

export async function readLibraryDatasheet(
  input: { id: string; kind: LibraryKind; source: LibraryDatasheetSource; page: number },
  signal: AbortSignal,
): Promise<DatasheetPage | null> {
  const response = await api('library-datasheet', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
  const value: unknown = await response.json();
  signal.throwIfAborted();
  if (value !== null && !isDatasheetPage(value, input.page))
    throw new Error('Invalid datasheet preview.');
  return value;
}
