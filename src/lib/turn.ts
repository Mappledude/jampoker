import { toSeatNumber } from './seats';

export function computeTurn(hand: any, mySeatRaw: unknown, myStackCents: number) {
  const mySeat = toSeatNumber(mySeatRaw);
  const toActSeat = toSeatNumber(hand?.toActSeat);
  if (hand == null || mySeat == null || toActSeat == null) return { ready: false } as const;

  const folded = new Set((hand.folded ?? []).map((x: any) => Number(x)));
  const commits = hand.commits ?? {};
  const myCommit = Number(commits[String(mySeat)] ?? 0);
  const toMatch = Number(hand.betToMatchCents ?? 0);
  const owe = Math.max(0, toMatch - myCommit);

  const canAct = toActSeat === mySeat && !folded.has(mySeat);
  const canCheck = canAct && owe === 0;
  const canCall = canAct && owe > 0 && myStackCents >= owe;
  const canBet = canAct && toMatch === 0 && myStackCents > 0;
  const canFold = canAct;

  return {
    ready: true,
    mySeat,
    toActSeat,
    toMatch,
    myCommit,
    owe,
    canAct,
    canCheck,
    canCall,
    canBet,
    canFold,
  } as const;
}
