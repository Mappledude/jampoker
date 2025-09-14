export const toSeatNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
};

export const findMySeat = (seats: Array<any>, myUid: string): number | null => {
  // seat can be in seats[i].seat or the array index; support both
  for (let i = 0; i < seats.length; i++) {
    const s = seats[i];
    if (!s) continue;
    if (s.uid === myUid) {
      const n = toSeatNumber((s as any).seat ?? i);
      return n ?? null;
    }
  }
  return null;
};
