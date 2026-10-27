// Money is compared in integer cents so 0.1 + 0.2 style drift can never pass or fail a rule.
export function toCents(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(cents - n * 100) > 1e-6) return null;
  return cents;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
