import { toSeatNumber } from './seats';

interface Seat {
  uid?: string;
  stackCents?: number;
  [k: string]: any;
}

export function computeTurnFromDoc(
  handDoc: any,
  seats: Seat[],
  myUid: string
) {
  const mySeat = seats.findIndex((s) => s?.uid === myUid);
  const toActSeat = toSeatNumber(handDoc?.toActSeat);
  if (!handDoc || mySeat < 0 || toActSeat == null) return { ready: false } as const;

  const folded = new Set((handDoc.folded ?? []).map((x: any) => Number(x)));
  const commits = handDoc.commits ?? {};
  const myCommit = Number(commits[String(mySeat)] ?? 0);
  const toMatch = Number(handDoc.betToMatchCents ?? 0);
  const owe = Math.max(0, toMatch - myCommit);
  const myStack = Number(seats[mySeat]?.stackCents ?? 0);

  const canAct = toActSeat === mySeat && !folded.has(mySeat);
  const canCheck = canAct && owe === 0;
  const canCall = canAct && owe > 0 && myStack >= owe;
  const canBet = canAct && toMatch === 0 && myStack > 0;
  const canFold = canAct;

  return {
    ready: true,
    myUid,
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

export function computeWhatIfTurn(
  live: ReturnType<typeof computeTurnFromDoc>,
  kind: 'check' | 'call' | 'raise',
  amountCents?: number
) {
  const add =
    kind === 'call'
      ? live.owe
      : kind === 'raise'
      ? Number(amountCents || 0)
      : 0;
  const myCommit = live.myCommit + add;
  const toMatch = kind === 'raise' ? live.toMatch + add : live.toMatch;
  const owe = Math.max(0, toMatch - myCommit);
  return { ...live, myCommit, toMatch, owe } as typeof live;
}

