export function toSeatNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

export function findMySeat(seats: any[], myUid: string): number | null {
  const s = seats.find((x) => x?.uid === myUid);
  return toSeatNumber((s as any)?.seat ?? (s as any)?.id ?? null);
}
