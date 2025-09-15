import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

// ---------- helpers ----------
const sum = (obj: Record<string, number>) =>
  Object.values(obj || {}).reduce((m, v) => m + Number(v || 0), 0);

function loadSeatDocsSnapToArray(seatsSnap: FirebaseFirestore.QuerySnapshot) {
  const seats: any[] = [];
  seatsSnap.forEach((d) => seats.push({ id: d.id, ...d.data() }));
  return seats;
}

function isOccupied(sd: any) {
  return !!(sd?.occupiedBy || sd?.uid);
}

function activeSeatIndices(seats: any[], hand: any): number[] {
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  return seats.filter(isOccupied).map((s) => s.seatIndex).filter((i) => !folded.has(i)).sort((a,b)=>a-b);
}

function nextActiveSeat(seats: any[], hand: any, start: number): number {
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  for (let step = 1; step <= 9; step++) {
    const idx = (start + step) % 9;
    const sd = seats.find((s) => s.seatIndex === idx);
    if (sd && isOccupied(sd) && !folded.has(idx)) return idx;
  }
  return start;
}

function streetStarter(hand: any, seats: any[]) {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : hand.dealerSeat ?? 0;
    return nextActiveSeat(seats, hand, bb);
  }
  return nextActiveSeat(seats, hand, hand.dealerSeat ?? 0);
}

function nextStreet(street: string) {
  return street === 'preflop' ? 'flop'
       : street === 'flop'    ? 'turn'
       : street === 'turn'    ? 'river'
       : 'showdown';
}

function advanceStreet(hand: any, seats: any[]) {
  const street = nextStreet(hand.street);
  const toAct = street === 'showdown' ? null : streetStarter(hand, seats);
  return {
    street,
    betToMatchCents: 0,
    lastAggressorSeat: null,
    toActSeat: toAct,
    updatedAt: FieldValue.serverTimestamp(),
    version: FieldValue.increment(1),
  };
}

function minRaiseIncrement(hand: any, table: any): number {
  const bb = Number(table?.blinds?.bbCents ?? 0);
  // Classic rule: minimum raise size = max(bb, current bet increment)
  const toMatch = Number(hand?.betToMatchCents ?? 0);
  const lastAgg = hand?.lastAggressorSeat;
  const lastAggCommit = Number(hand?.commits?.[String(lastAgg)] ?? 0);
  const inc = Math.max(0, toMatch - lastAggCommit);
  return Math.max(bb, inc);
}

export const takeActionTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId, actionId } = request.data || {};
  if (!tableId || !actionId) throw new HttpsError('invalid-argument', 'missing-fields');

  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const tableRef = db.doc(`tables/${tableId}`);
  const actionRef = db.doc(`tables/${tableId}/actions/${actionId}`);
  const seatsCol = tableRef.collection('seats');

  await db.runTransaction(async (tx) => {
    const [handSnap, tableSnap, actionSnap, seatsSnap] = await Promise.all([
      tx.get(handRef),
      tx.get(tableRef),
      tx.get(actionRef),
      tx.get(seatsCol),
    ]);

    const hand = handSnap.data() as any;
    const table = tableSnap.data() as any;
    const action = actionSnap.data() as any;
    if (!hand || !table || !action) throw new HttpsError('failed-precondition', 'missing-docs');
    if (action.applied === true) return; // idempotent

    const seats = loadSeatDocsSnapToArray(seatsSnap);
    const seatIdx = Number(action.seat);
    if (hand.toActSeat !== seatIdx) throw new HttpsError('failed-precondition', 'not-your-turn');

    // Validate actor matches seat
    const seatDoc = seats.find((s) => s.seatIndex === seatIdx) || {};
    const seatOccupant = seatDoc?.occupiedBy || seatDoc?.uid || null;
    if (action.actorUid && seatOccupant && action.actorUid !== seatOccupant) {
      throw new HttpsError('permission-denied', 'seat-mismatch');
    }

    const commits: Record<string, number> = { ...(hand.commits ?? {}) };
    const key = String(seatIdx);
    const myCommit = Number(commits[key] ?? 0);
    const toMatch = Number(hand.betToMatchCents ?? 0);
    const owe = Math.max(0, toMatch - myCommit);

    const starter = streetStarter(hand, seats);
    const nextSeat = nextActiveSeat(seats, hand, seatIdx);
    const actives = activeSeatIndices(seats, hand);

    let updates: any = {
      updatedAt: FieldValue.serverTimestamp(),
      lastActionId: actionId,
    };

    const type: string = action.type;

    if (type === 'check') {
      if (owe > 0) throw new HttpsError('failed-precondition', 'cannot-check-when-owed');
      // everyone matched?
      const allMatched = actives.every((i) => (Number(commits[String(i)] ?? 0) >= toMatch));
      updates.potCents = sum(commits);
      if (allMatched && nextSeat === starter) {
        updates = { ...updates, ...advanceStreet(hand, seats) };
      } else {
        updates.toActSeat = nextSeat;
      }
    } else if (type === 'call') {
      if (owe > 0) {
        commits[key] = myCommit + owe;
        updates.commits = commits;
      }
      updates.potCents = sum(commits);
      const allMatched = actives.every((i) => (Number(commits[String(i)] ?? 0) >= toMatch));
      if (allMatched && nextSeat === starter) {
        updates = { ...updates, ...advanceStreet(hand, seats) };
      } else {
        updates.toActSeat = nextSeat;
      }
    } else if (type === 'bet' || type === 'raise') {
      const target = Number(action.amountCents);
      if (!Number.isFinite(target) || target <= myCommit) {
        throw new HttpsError('invalid-argument', 'bad-amount');
      }
      // bet only allowed when no bet outstanding; raise when there is one
      if (type === 'bet' && toMatch !== 0) throw new HttpsError('failed-precondition', 'cannot-bet-when-bet-exists');
      if (type === 'raise' && toMatch === 0) throw new HttpsError('failed-precondition', 'cannot-raise-when-no-bet');

      const minInc = minRaiseIncrement(hand, table);
      const minTarget = Math.max(toMatch + minInc, myCommit + minInc);
      if (target < minTarget) {
        throw new HttpsError('failed-precondition', 'min-raise-not-met');
      }

      // Move my total commit up to `target`; set new toMatch to target
      commits[key] = target;
      updates.commits = commits;
      updates.potCents = sum(commits);
      updates.betToMatchCents = target;
      updates.lastAggressorSeat = seatIdx;

      // After raise, action goes to next seat (never closes immediately)
      updates.toActSeat = nextSeat;
    } else {
      throw new HttpsError('invalid-argument', 'unsupported-action');
    }

    tx.update(handRef, updates);
    // Mark action applied atomically
    tx.update(actionRef, {
      applied: true,
      invalid: false,
      appliedAt: FieldValue.serverTimestamp(),
    });
  });
});
