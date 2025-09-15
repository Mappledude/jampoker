import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from './admin';
import { normalizeCommits, sumCommits } from './lib/normalize';

type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

type ActionType = 'check' | 'call' | 'bet' | 'raise' | 'fold';

interface ActionDoc {
  handNo: number;
  seat: number;
  type: ActionType;
  amountCents?: number | null;
  createdByUid?: string | null;
  actorUid?: string | null;
  createdAt?: Timestamp | null;
  applied?: boolean;
  invalid?: boolean;
  clientTs?: number;
  error?: string;
}

interface HandState {
  handNo: number;
  street: Street;
  dealerSeat: number;
  sbSeat: number;
  bbSeat: number;
  toActSeat: number | null;
  betToMatchCents: number;
  commits: Record<string, number>; // current street commits
  lastAggressorSeat: number | null;
  lastRaiseSizeCents?: number | null;
  lastRaiseToCents?: number | null;
  folded?: number[]; // seat indices
  potCents?: number; // running total across streets
  updatedAt?: Timestamp | FirebaseFirestore.FieldValue;
  version?: number | FirebaseFirestore.FieldValue;
  lastActionId?: string | null;
  lastWriteBy?: string | null;
}

function buildSeatUids(seatDocs: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>): (string | null)[] {
  const map = new Map<number, string | null>();
  seatDocs.forEach(d => {
    const data = d.data() || {};
    const i = Number(data.seatIndex);
    const uid = (data.uid ?? data.occupiedBy) ?? null;
    if (Number.isInteger(i)) map.set(i, uid);
  });
  const maxI = Math.max(8, ...Array.from(map.keys()));
  const arr: (string | null)[] = [];
  for (let i = 0; i <= maxI; i++) arr[i] = map.get(i) ?? null;
  return arr;
}

function isFolded(hand: HandState, seat: number): boolean {
  const f = new Set((hand.folded ?? []).map(n => Number(n)));
  return f.has(Number(seat));
}

function nextActiveSeat(seatUids: (string | null)[], hand: HandState, start: number): number {
  const total = seatUids.length;
  for (let step = 1; step <= total; step++) {
    const idx = (start + step) % total;
    if (seatUids[idx] && !isFolded(hand, idx)) return idx;
  }
  return start;
}

function activeSeats(seatUids: (string | null)[], hand: HandState): number[] {
  const out: number[] = [];
  for (let i = 0; i < seatUids.length; i++) {
    if (seatUids[i] && !isFolded(hand, i)) out.push(i);
  }
  return out;
}

function streetStarter(seatUids: (string | null)[], hand: HandState): number {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : (hand.dealerSeat ?? 0);
    return nextActiveSeat(seatUids, hand, bb);
  }
  // postflop streets start left of dealer
  return nextActiveSeat(seatUids, hand, hand.dealerSeat ?? 0);
}

function nextStreet(street: Street): Street {
  switch (street) {
    case 'preflop': return 'flop';
    case 'flop': return 'turn';
    case 'turn': return 'river';
    default: return 'showdown';
  }
}

export const takeActionTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId, actionId } = request.data || {};
  const now = Date.now();
  if (!tableId || !actionId) {
    throw new HttpsError('invalid-argument', 'missing { tableId, actionId }');
  }

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const actionRef = db.doc(`tables/${tableId}/actions/${actionId}`);
  const seatsCol = tableRef.collection('seats');

  await db.runTransaction(async (tx) => {
    const [tableSnap, handSnap, actionSnap, seatsSnap] = await Promise.all([
      tx.get(tableRef),
      tx.get(handRef),
      tx.get(actionRef),
      tx.get(seatsCol),
    ]);

    const handData = handSnap.data() as HandState | undefined;
    console.log('takeActionTX.in', {
      tableId,
      actionId,
      now,
      commitsShape: typeof handData?.commits,
    });

    if (!tableSnap.exists) throw new HttpsError('failed-precondition', 'table-missing');
    if (!handSnap.exists) throw new HttpsError('failed-precondition', 'hand-missing');
    if (!actionSnap.exists) throw new HttpsError('invalid-argument', 'action-missing');

    const table = tableSnap.data() as any;
    const hand = handData as HandState;
    const action = actionSnap.data() as ActionDoc;

    if (action.applied === true || action.invalid === true) {
      // Idempotent: already processed
      return;
    }

    // Validate hand number matches
    if (typeof action.handNo !== 'number' || action.handNo !== hand.handNo) {
      tx.update(actionRef, {
        applied: true,
        invalid: true,
        error: 'hand-mismatch',
        reason: 'hand-mismatch',
        appliedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Build seat occupancy
    const seatUids = buildSeatUids(seatsSnap);
    const seat = Number(action.seat);
    const actorUid = action.actorUid ?? null;

    // Validate seat and actor
    if (!Number.isInteger(seat) || seat < 0 || seat >= seatUids.length) {
      tx.update(actionRef, {
        applied: true,
        invalid: true,
        error: 'bad-seat',
        reason: 'bad-seat',
        appliedAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    if (!seatUids[seat]) {
      tx.update(actionRef, {
        applied: true,
        invalid: true,
        error: 'seat-empty',
        reason: 'seat-empty',
        appliedAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    if (actorUid && seatUids[seat] && actorUid !== seatUids[seat]) {
      tx.update(actionRef, {
        applied: true,
        invalid: true,
        error: 'actor-seat-mismatch',
        reason: 'actor-seat-mismatch',
        appliedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Validate turn
    if (hand.toActSeat !== seat) {
      tx.update(actionRef, {
        applied: true,
        invalid: true,
        error: 'not-your-turn',
        reason: 'not-your-turn',
        appliedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    // Prepare betting variables
    const baseCommits = normalizeCommits(hand.commits);
    const commits: Record<string, number> = { ...baseCommits };
    const key = String(seat);
    const myCommit = commits[key] ?? 0;
    const toMatch = hand.betToMatchCents ?? 0;
    const owe = Math.max(0, toMatch - myCommit);

    const bbCents = Number(table?.blinds?.bbCents || 0);
    const minRaiseBase = Math.max(Number(hand.lastRaiseSizeCents || 0), bbCents);

    const startSeat = streetStarter(seatUids, hand);
    const nextSeat = nextActiveSeat(seatUids, hand, seat);
    const actives = activeSeats(seatUids, hand);
    const potBankedBefore = typeof hand.potCents === 'number' ? hand.potCents : 0;
    const streetPotBefore = sumCommits(baseCommits);
    const computeBankedTotal = () => potBankedBefore + sumCommits(commits);

    const updates: Partial<HandState> & Record<string, any> = {
      lastActionId: actionId,
      updatedAt: FieldValue.serverTimestamp(),
      lastWriteBy: 'cf:takeActionTX',
      version: FieldValue.increment(1),
    };

    const type = action.type as ActionType;

    if (type === 'check') {
      if (owe > 0) throw new HttpsError('failed-precondition', 'cannot-check-when-owe');
      // rotate or advance
      const allMatched = actives.every(s => (commits[String(s)] ?? 0) >= toMatch); // true for 0
      if (nextSeat === startSeat && allMatched) {
        // advance street
        const pot = computeBankedTotal();
        const street = nextStreet(hand.street);
        updates.street = street;
        updates.betToMatchCents = 0;
        updates.lastAggressorSeat = null;
        updates.lastRaiseSizeCents = null;
        updates.lastRaiseToCents = null;
        updates.potCents = pot;
        updates.commits = {}; // reset street commits
        updates.toActSeat = street === 'showdown' ? null : streetStarter(seatUids, hand);
      } else {
        updates.toActSeat = nextSeat;
      }
    } else if (type === 'call') {
      if (owe <= 0) {
        // treat as check when nothing owed
        const allMatched = actives.every(s => (commits[String(s)] ?? 0) >= toMatch);
        if (nextSeat === startSeat && allMatched) {
          const pot = computeBankedTotal();
          const street = nextStreet(hand.street);
          updates.street = street;
          updates.betToMatchCents = 0;
          updates.lastAggressorSeat = null;
          updates.lastRaiseSizeCents = null;
          updates.lastRaiseToCents = null;
          updates.potCents = pot;
          updates.commits = {};
          updates.toActSeat = street === 'showdown' ? null : streetStarter(seatUids, hand);
        } else {
          updates.toActSeat = nextSeat;
        }
      } else {
        // pay owe to match
        commits[key] = myCommit + owe;
        const newToMatch = toMatch; // unchanged on a call
        const allMatched = actives.every(s => (commits[String(s)] ?? 0) >= newToMatch);
        if (nextSeat === startSeat && allMatched) {
          const pot = computeBankedTotal();
          const street = nextStreet(hand.street);
          updates.street = street;
          updates.betToMatchCents = 0;
          updates.lastAggressorSeat = null;
          updates.lastRaiseSizeCents = null;
          updates.lastRaiseToCents = null;
          updates.potCents = pot;
          updates.commits = {};
          updates.toActSeat = street === 'showdown' ? null : streetStarter(seatUids, hand);
        } else {
          updates.toActSeat = nextSeat;
          updates.commits = commits;
          updates.betToMatchCents = newToMatch;
        }
      }
    } else if (type === 'bet') {
      const amt = Number(action.amountCents || 0);
      if (toMatch !== 0) throw new HttpsError('failed-precondition', 'cannot-bet-when-already-bet');
      if (!Number.isFinite(amt) || amt <= 0) throw new HttpsError('invalid-argument', 'bad-bet');
      if (amt < bbCents) throw new HttpsError('failed-precondition', 'bet-below-bb');
      // absolute target becomes myCommit + amt
      commits[key] = myCommit + amt;
      const newToMatch = commits[key];
      updates.commits = commits;
      updates.betToMatchCents = newToMatch;
      updates.lastAggressorSeat = seat;
      updates.lastRaiseSizeCents = amt;
      updates.lastRaiseToCents = newToMatch;
      updates.toActSeat = nextSeat;
    } else if (type === 'raise') {
      if (toMatch <= 0) throw new HttpsError('failed-precondition', 'cannot-raise-without-bet');
      const raiseSize = Number(action.amountCents || 0); // size of raise (not total)
      if (!Number.isFinite(raiseSize) || raiseSize <= 0) throw new HttpsError('invalid-argument', 'bad-raise');
      if (raiseSize < minRaiseBase) throw new HttpsError('failed-precondition', 'raise-below-min');

      const newToMatch = toMatch + raiseSize; // absolute target after raise
      const delta = Math.max(0, newToMatch - myCommit);
      commits[key] = myCommit + delta;

      updates.commits = commits;
      updates.betToMatchCents = newToMatch;
      updates.lastAggressorSeat = seat;
      updates.lastRaiseSizeCents = raiseSize;
      updates.lastRaiseToCents = newToMatch;
      updates.toActSeat = nextSeat;
    } else if (type === 'fold') {
      const folded = new Set((hand.folded ?? []).map(n => Number(n)));
      folded.add(seat);
      updates.folded = Array.from(folded.values()).sort((a, b) => a - b);

      const remain = activeSeats(seatUids, { ...hand, folded: updates.folded } as HandState);
      if (remain.length <= 1) {
        // hand ends
        const pot = computeBankedTotal();
        updates.street = 'showdown';
        updates.toActSeat = null;
        updates.potCents = pot;
        updates.commits = {};
        updates.betToMatchCents = 0;
        updates.lastAggressorSeat = null;
        updates.lastRaiseSizeCents = null;
        updates.lastRaiseToCents = null;
      } else {
        // continue to next player
        updates.toActSeat = nextActiveSeat(seatUids, { ...hand, folded: updates.folded } as HandState, seat);
      }
    } else {
      throw new HttpsError('invalid-argument', 'bad-action-type');
    }

    // Write hand updates
    const commitsAfterForLog = normalizeCommits(updates.commits ?? hand.commits);
    const streetPotAfter = sumCommits(commitsAfterForLog);
    const potBankedAfter = typeof updates.potCents === 'number'
      ? updates.potCents
      : typeof hand.potCents === 'number'
        ? hand.potCents
        : 0;
    const potDisplayBefore = potBankedBefore + streetPotBefore;
    const potDisplayAfter = potBankedAfter + streetPotAfter;

    console.log('takeActionTX.apply', {
      tableId, actionId,
      type: action?.type, seat: action?.seat,
      handNoBefore: hand?.handNo,
      toActBefore: hand?.toActSeat,
      betToMatchBefore: hand?.betToMatchCents,
      potBankedBefore,
      streetPotBefore,
      potDisplayBefore,
      potBankedAfter,
      streetPotAfter,
      potDisplayAfter,
      commitsShape: typeof hand?.commits,
      updatesPreview: {
        toActSeat: updates.toActSeat ?? null,
        street: updates.street ?? hand?.street,
        betToMatchCents: updates.betToMatchCents ?? hand?.betToMatchCents,
        potCents: updates.potCents ?? hand?.potCents ?? null,
        potBankedAfter,
        potDisplayAfter,
      }
    });
    tx.update(handRef, updates);

    // Mark action applied here so worker doesn’t reprocess
    tx.update(actionRef, {
      applied: true,
      invalid: false,
      reason: null,
      appliedAt: FieldValue.serverTimestamp(),
    });
  });
});
