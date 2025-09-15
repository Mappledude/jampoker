interface Seat {
  uid?: string;
  stackCents?: number;
  [k: string]: any;
}

// Computes the live turn state from a Firestore snapshot. This should be used
// for guards and writes. For UI previews, use `computeWhatIfTurn` instead and
// never feed the preview back into guards.
export function computeLiveTurn(
  handDoc: any,
  seats: Seat[],
  authUid: string
) {
  const mySeat = seats.findIndex((s) => s?.uid === authUid);
  const commits = handDoc?.commits ?? {};
  const myCommit = commits[String(mySeat)] ?? 0;
  const toMatch = handDoc?.betToMatchCents ?? 0;
  const streetPotCents = Object.values(commits).reduce(
    (sum: number, v: any) => sum + Number(v || 0),
    0
  );
  const potBankedCents = typeof handDoc?.potCents === 'number' ? handDoc.potCents : 0;
  const potDisplayCents = potBankedCents + streetPotCents;
  return {
    myUid: authUid,
    mySeat,
    toActSeat: handDoc?.toActSeat ?? null,
    street: handDoc?.street ?? null,
    handNo: handDoc?.handNo ?? null,
    toMatch,
    myCommit,
    owe: Math.max(0, toMatch - myCommit),
    potCents: potDisplayCents,
    potBankedCents,
    potDisplayCents,
    streetPotCents,
  };
}

// UI-only preview; do NOT use in guards.
export function computeWhatIfTurn(
  live: ReturnType<typeof computeLiveTurn>,
  kind: 'check' | 'call' | 'raise',
  amountCents = 0
) {
  const add = kind === 'call' ? live.owe : kind === 'raise' ? amountCents : 0;
  return { ...live, myCommit: live.myCommit + add };
}

