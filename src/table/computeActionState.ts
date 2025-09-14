import { HandState } from '../poker/handMath';

export interface Seat {
  uid: string;
  stackCents: number;
  [key: string]: any;
}

export type ActionStateReason = 'no-hand' | 'not-seated' | 'not-your-turn' | 'ok';

export interface ActionState {
  enabled: boolean;
  reason: ActionStateReason;
  seatIndex?: number;
  toAct?: number | null;
  betToMatch?: number;
  myCommit?: number;
  deltaToCall?: number;
  stack?: number;
  canCheck?: boolean;
  canCall?: boolean;
  canRaise?: boolean;
  canFold?: boolean;
}

export function computeActionState({
  uid,
  seats,
  handState,
}: {
  uid: string;
  seats: Seat[];
  handState: HandState | null;
}): ActionState {
  if (!handState) return { enabled: false, reason: 'no-hand' };

  const seatIndex = seats.findIndex((s) => s?.uid === uid);
  if (seatIndex < 0) return { enabled: false, reason: 'not-seated' };

  const toAct = handState.toActSeat;
  if (toAct !== seatIndex) return { enabled: false, reason: 'not-your-turn', seatIndex, toAct };

  const myCommit = (handState.commits && handState.commits[String(seatIndex)]) ?? 0;
  const betToMatch = handState.betToMatchCents ?? 0;
  const deltaToCall = Math.max(0, betToMatch - myCommit);

  const seat = seats[seatIndex];
  const stack = seat?.stackCents ?? 0;

  const canCheck = deltaToCall === 0;
  const canCall = deltaToCall > 0 && stack >= deltaToCall;
  const canRaise = stack > deltaToCall;
  const canFold = true;

  return {
    enabled: true,
    reason: 'ok',
    seatIndex,
    toAct,
    betToMatch,
    myCommit,
    deltaToCall,
    stack,
    canCheck,
    canCall,
    canRaise,
    canFold,
  };
}
