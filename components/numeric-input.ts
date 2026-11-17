/** Decimal form input for solid property panels. */
export function parseNumericInput(text: string, label: string): number {
  const value = Number(text);
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text.trim()) || !Number.isFinite(value))
    throw new Error(`${label}: enter a finite number.`);
  return value;
}
