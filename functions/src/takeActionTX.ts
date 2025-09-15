import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

// --- helpers (keep simple for now) ---
const sum = (obj: Record<string, number>) =>
  Object.values(obj || {}).reduce((m, v) => m + Number(v || 0), 0);

function nextActiveSeat(seats: any[], hand: any, start: number): number {
  const total = seats.length || 9;
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  for (let i = 1; i <= total; i++) {
    const idx = (start + i) % total;
    const seat = seats[idx];
    if (seat?.uid && !folded.has(idx)) return idx;
  }
  return start;
}
function streetStarter(seats: any[], hand: any): number {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : hand.dealerSeat;
    return nextActiveSeat(seats, hand, bb);
  }
  return nextActiveSeat(seats, hand, hand.dealerSeat ?? 0);
}
function nextStreet(street: string): string {
  return street === 'preflop'
    ? 'flop'
    : street === 'flop'
    ? 'turn'
    : street === 'turn'
    ? 'river'
    : 'showdown';
}
function advanceStreet(hand: any, seats: any[]) {
  const street = nextStreet(hand.street);
  const toAct = street === 'showdown' ? null : streetStarter(seats, hand);
  return {
    street,
    betToMatchCents: 0,
    lastAggressorSeat: null,
    toActSeat: toAct,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export const takeActionTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId, actionId } = request.data || {};
  if (!tableId || !actionId) throw new HttpsError('invalid-argument', 'missing-fields');

  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const tableRef = db.doc(`tables/${tableId}`);
  const actionRef = db.doc(`tables/${tableId}/actions/${actionId}`);

  await db.runTransaction(async (tx) => {
    const [handSnap, tableSnap, actionSnap] = await Promise.all([
      tx.get(handRef),
      tx.get(tableRef),
      tx.get(actionRef),
    ]);

    const hand = handSnap.data() as any;
    const table = tableSnap.data() as any;
    const action = actionSnap.data() as any;
    if (!hand || !table || !action)
      throw new HttpsError('failed-precondition', 'missing-docs');
    if (action.applied === true) return; // idempotent

    const seats = table?.seats ?? [];
    const seatIdx = Number(action.seat);
    if (hand.toActSeat !== seatIdx)
      throw new HttpsError('failed-precondition', 'not-your-turn');

    // Actor sanity: accept either seats[i].uid or occupiedBy
    const seatOccupant = seats?.[seatIdx]?.uid ?? seats?.[seatIdx]?.occupiedBy ?? null;
    if (action.actorUid && seatOccupant && action.actorUid !== seatOccupant) {
      throw new HttpsError('permission-denied', 'seat-mismatch');
    }

    const commits: Record<string, number> = { ...(hand.commits ?? {}) };
    const key = String(seatIdx);
    const myCommit = commits[key] ?? 0;
    const toMatch = Number(hand.betToMatchCents ?? 0);
    const owe = Math.max(0, toMatch - myCommit);

    const starter = streetStarter(seats, hand);
    const nextSeat = nextActiveSeat(seats, hand, seatIdx);
    const actives = seats
      .map((s: any, i: number) => (s?.uid ? i : -1))
      .filter((i: number) => i >= 0);

    let updates: any = {
      updatedAt: FieldValue.serverTimestamp(),
      lastActionId: actionId,
    };

    if (action.type === 'check') {
      if (owe > 0) throw new HttpsError('failed-precondition', 'cannot-check');
      const allMatched = actives.every((i) => (commits[String(i)] ?? 0) >= toMatch);
      if (allMatched && nextSeat === starter) {
        updates = { ...updates, ...advanceStreet(hand, seats), potCents: sum(commits) };
      } else {
        updates = { ...updates, toActSeat: nextSeat, potCents: sum(commits) };
      }
    } else if (action.type === 'call') {
      if (owe > 0) {
        commits[key] = myCommit + owe;
        updates.commits = commits;
      }
      updates.potCents = sum(commits);
      const allMatched = actives.every((i) => (commits[String(i)] ?? 0) >= toMatch);
      if (allMatched && nextSeat === starter) {
        updates = { ...updates, ...advanceStreet(hand, seats) };
      } else {
        updates.toActSeat = nextSeat;
      }
    } else {
      throw new HttpsError('invalid-argument', 'unsupported-in-02A');
    }

    tx.update(handRef, updates);
  });
});

