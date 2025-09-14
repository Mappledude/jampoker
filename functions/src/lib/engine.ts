export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface HandState {
  handNo: number;
  street: Street;
  dealerSeat: number;
  sbSeat: number;
  bbSeat: number;
  toActSeat: number | null;
  betToMatchCents: number;
  commits: number[]; // length 9
  lastAggressorSeat: number | null;
  activeSeats: boolean[]; // length 9
  version?: number;
}

export interface Action {
  handNo: number;
  seat: number;
  type: 'check' | 'call' | 'bet' | 'raise' | 'fold';
  amountCents?: number;
}

function activeSeatIndices(active: boolean[]): number[] {
  const seats: number[] = [];
  active.forEach((v, i) => {
    if (v) seats.push(i);
  });
  return seats;
}

function nextActiveSeat(active: boolean[], from: number): number {
  const seats = activeSeatIndices(active);
  const start = seats.indexOf(from);
  for (let i = 1; i <= seats.length; i++) {
    const seat = seats[(start + i) % seats.length];
    if (active[seat]) return seat;
  }
  return from;
}

function nextStreet(street: Street): Street {
  switch (street) {
    case 'preflop':
      return 'flop';
    case 'flop':
      return 'turn';
    case 'turn':
      return 'river';
    default:
      return 'showdown';
  }
}

function streetStarter(state: HandState): number {
  if (state.street === 'preflop') {
    return nextActiveSeat(state.activeSeats, state.bbSeat);
  }
  const active = activeSeatIndices(state.activeSeats);
  if (active.length === 2) {
    return state.bbSeat;
  }
  return nextActiveSeat(state.activeSeats, state.dealerSeat);
}

function allMatched(state: HandState): boolean {
  const toMatch = state.betToMatchCents;
  return activeSeatIndices(state.activeSeats).every(
    (s) => state.commits[s] === toMatch
  );
}

export function applyAction(state: HandState, action: Action): HandState {
  if (action.handNo !== state.handNo) throw new Error('wrong-hand');
  if (state.toActSeat !== action.seat) throw new Error('not-your-turn');

  const commits = state.commits.slice();
  const active = state.activeSeats.slice();
  let betToMatch = state.betToMatchCents;
  let lastAggressor = state.lastAggressorSeat;
  let street: Street = state.street;

  const nextSeat = () => nextActiveSeat(active, action.seat);

  switch (action.type) {
    case 'check': {
      if (commits[action.seat] !== betToMatch) throw new Error('cannot-check');
      state.toActSeat = nextSeat();
      break;
    }
    case 'call': {
      commits[action.seat] = betToMatch;
      state.toActSeat = nextSeat();
      break;
    }
    case 'bet': {
      if (betToMatch !== commits[action.seat]) throw new Error('cannot-bet');
      if (!action.amountCents || action.amountCents <= 0) throw new Error('bad-amount');
      commits[action.seat] += action.amountCents;
      betToMatch = commits[action.seat];
      lastAggressor = action.seat;
      state.toActSeat = nextSeat();
      break;
    }
    case 'raise': {
      if (!action.amountCents || action.amountCents <= 0) throw new Error('bad-amount');
      const newToMatch = commits[action.seat] + action.amountCents;
      if (newToMatch <= betToMatch) throw new Error('bad-amount');
      commits[action.seat] = newToMatch;
      betToMatch = newToMatch;
      lastAggressor = action.seat;
      state.toActSeat = nextSeat();
      break;
    }
    case 'fold': {
      active[action.seat] = false;
      const remaining = activeSeatIndices(active);
      if (remaining.length <= 1) {
        street = 'showdown';
        betToMatch = 0;
        commits.fill(0);
        lastAggressor = null;
        state.toActSeat = null;
      } else {
        state.toActSeat = nextSeat();
      }
      break;
    }
    default:
      throw new Error('bad-action');
  }

  const next: HandState = {
    ...state,
    street,
    betToMatchCents: betToMatch,
    commits,
    lastAggressorSeat: lastAggressor,
    activeSeats: active,
  };

  if (street !== 'showdown' && action.type !== 'fold') {
    const nextSeatVal = next.toActSeat!;
    const starter = streetStarter(next);
    const shouldAdv =
      allMatched(next) &&
      (lastAggressor != null ? nextSeatVal === lastAggressor : nextSeatVal === starter);
    if (shouldAdv) {
      const newStreet = nextStreet(street);
      next.street = newStreet;
      next.betToMatchCents = 0;
      next.commits = Array(9).fill(0);
      next.lastAggressorSeat = null;
      next.toActSeat = newStreet === 'showdown' ? null : streetStarter(next);
    }
  }

  return next;
}

export const _private = {
  activeSeatIndices,
  nextActiveSeat,
  nextStreet,
  streetStarter,
  allMatched,
};

