type HandState = {
  toActSeat: unknown;
  betToMatchCents?: unknown;
  commits?: Record<string, unknown>;
  folded?: unknown[];
  street?: string;
};

export function computeTurn(hand: HandState | null, mySeat: number | null, myStackCents: number) {
  if (!hand || mySeat == null) return { ready: false } as const;

  const toActSeat = Number((hand as any).toActSeat ?? -1);
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  const commits = hand?.commits ?? {};
  const myCommit = Number(commits[String(mySeat)] ?? 0);
  const toMatch = Number((hand as any).betToMatchCents ?? 0);
  const owe = Math.max(0, toMatch - myCommit);

  const canAct = toActSeat === mySeat && !folded.has(mySeat);
  const canCheck = canAct && owe === 0;
  const canCall = canAct && owe > 0 && myStackCents >= owe;
  const canBet = canAct && toMatch === 0 && myStackCents > 0;
  const canFold = canAct;

  return { ready: true, toActSeat, toMatch, myCommit, owe, canAct, canCheck, canCall, canBet, canFold } as const;
}
