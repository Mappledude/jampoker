export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface HandState {
  street: Street;
  toActSeat: number | null;
  dealerSeat?: number | null;
  betToMatchCents: number;
  commits: Record<number, number>;
  activeSeats?: number[]; // optional list of active seat indexes
  folded?: Record<number, boolean>;
  lastAggressorSeat?: number | null;
}

export function computeToCall(hand: HandState, seat: number): number {
  const committed = hand.commits?.[seat] ?? 0;
  return Math.max(0, (hand.betToMatchCents || 0) - committed);
}

export function computeLegalActions(hand: HandState, seat: number) {
  const toCall = computeToCall(hand, seat);
  return {
    check: toCall === 0,
    call: toCall > 0,
  };
}

function seatsInOrder(hand: HandState): number[] {
  if (hand.activeSeats && hand.activeSeats.length) {
    return [...hand.activeSeats].sort((a, b) => a - b);
  }
  return Object.keys(hand.commits || {})
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);
}

export function nextToAct(hand: HandState, fromSeat?: number | null): number | null {
  const seats = seatsInOrder(hand);
  if (seats.length === 0) return null;
  const start = fromSeat ?? hand.toActSeat ?? seats[0];
  const startIdx = seats.indexOf(start);
  for (let i = 1; i <= seats.length; i++) {
    const seat = seats[(startIdx + i) % seats.length];
    if (hand.folded && hand.folded[seat]) continue;
    return seat;
  }
  return null;
}

export function nextStreet(street: Street): Street {
  switch (street) {
    case 'preflop':
      return 'flop';
    case 'flop':
      return 'turn';
    case 'turn':
      return 'river';
    default:
      return 'river';
  }
}

export function firstToActOnNextStreet(hand: HandState): number | null {
  if (hand.dealerSeat == null) return nextToAct(hand);
  return nextToAct(hand, hand.dealerSeat);
}

export function everyoneMatched(hand: HandState): boolean {
  const seats = seatsInOrder(hand);
  const target = hand.betToMatchCents || 0;
  return seats.every((seat) => (hand.commits?.[seat] ?? 0) >= target);
}

export function maybeAdvanceStreet(hand: HandState) {
  if (everyoneMatched(hand)) {
    return {
      street: nextStreet(hand.street),
      betToMatchCents: 0,
      lastAggressorSeat: null,
      toActSeat: firstToActOnNextStreet(hand),
    } as Partial<HandState>;
  }
  return { toActSeat: nextToAct(hand) } as Partial<HandState>;
}
