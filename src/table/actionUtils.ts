import { HandState } from '../poker/handMath';

export interface Seat {
  seat: number;
  uid: string;
  stackCents: number;
  [key: string]: any;
}

export function findMySeatIndex(seats: Array<{ seat: number; uid: string }>, myUid: string): number | null {
  const s = seats.find((s) => s.uid === myUid);
  return s ? s.seat ?? null : null;
}

export function isMyTurn(handState: HandState | null, mySeat: number | null): boolean {
  if (mySeat == null) return false;
  if (!handState) return false;
  const folded = handState.folded as any;
  const amFolded = Array.isArray(folded) ? folded.includes(mySeat) : !!folded?.[mySeat];
  return handState.toActSeat === mySeat && !amFolded;
}

function commitsOf(handState: HandState, seat: number) {
  return (handState.commits && handState.commits[String(seat)]) || 0;
}

export function deriveActionAvailability(
  handState: HandState | null,
  mySeat: number | null,
  myStackCents: number
) {
  if (!handState || mySeat == null) {
    return {
      canAct: false,
      canCheck: false,
      canCall: false,
      canBet: false,
      canRaise: false,
      canFold: false,
      callAmount: 0,
      minRaiseTo: 0,
    };
  }
  const meCommit = commitsOf(handState, mySeat);
  const toMatch = handState.betToMatchCents || 0;
  const owe = Math.max(0, toMatch - meCommit);

  const canAct = isMyTurn(handState, mySeat);
  const canCheck = canAct && owe === 0;
  const canCall = canAct && owe > 0 && myStackCents >= owe;
  const canBet = canAct && toMatch === 0 && myStackCents > 0;
  const minRaiseTo = handState.minRaiseToCents || 0;
  const lastAggressorPrevBet = (handState as any).lastAggressorPrevBet || toMatch;
  const canRaise =
    canAct &&
    toMatch > 0 &&
    myStackCents + meCommit >= Math.max(minRaiseTo, toMatch + (toMatch - lastAggressorPrevBet));
  const canFold = canAct;

  return { canAct, canCheck, canCall, canBet, canRaise, canFold, callAmount: owe, minRaiseTo };
}

