import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

// ---- helpers ----
const sum = (obj: Record<string, number>) =>
  Object.values(obj || {}).reduce((m, v) => m + Number(v || 0), 0);

function nextActiveSeat(seatDocs: any[], hand: any, start: number): number {
  const total = 9;
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  for (let i = 1; i <= total; i++) {
    const idx = (start + i) % total;
    const sd = seatDocs.find((d) => d?.seatIndex === idx);
    const occupied = !!(sd?.occupiedBy || sd?.uid);
    if (occupied && !folded.has(idx)) return idx;
  }
  return start;
}
function streetStarter(hand: any, seatDocs: any[]) {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : hand.dealerSeat;
    return nextActiveSeat(seatDocs, hand, bb);
  }
  return nextActiveSeat(seatDocs, hand, hand.dealerSeat ?? 0);
}
function nextStreet(street: string) {
  return street === 'preflop' ? 'flop'
       : street === 'flop'    ? 'turn'
       : street === 'turn'    ? 'river'
       : 'showdown';
}
function advanceStreet(hand: any, seatDocs: any[]) {
  const street = nextStreet(hand.street);
  const toAct = street === 'showdown' ? null : streetStarter(hand, seatDocs);
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
  const seatsCol = tableRef.collection('seats');

  await db.runTransaction(async (tx) => {
    const [handSnap, tableSnap, actionSnap, seatsSnap] = await Promise.all([
      tx.get(handRef),
      tx.get(tableRef),
      tx.get(actionRef),
      tx.get(seatsCol), // read actual seat docs
    ]);

    const hand = handSnap.data() as any;
    const table = tableSnap.data() as any;
    const action = actionSnap.data() as any;
    if (!hand || !table || !action) throw new HttpsError('failed-precondition', 'missing-docs');
    if (action.applied === true) return; // idempotent

    const seats: any[] = [];
    seatsSnap.forEach((d) => seats.push({ id: d.id, ...d.data() }));

    const seatIdx = Number(action.seat);
    if (hand.toActSeat !== seatIdx) throw new HttpsError('failed-precondition', 'not-your-turn');

    // Validate actor: accept either occupiedBy or uid on the seat doc
    const seatDoc = seats.find((s) => s.seatIndex === seatIdx) || {};
    const seatOccupant = seatDoc?.occupiedBy || seatDoc?.uid || null;
    if (action.actorUid && seatOccupant && action.actorUid !== seatOccupant) {
      throw new HttpsError('permission-denied', 'seat-mismatch');
    }

    const commits: Record<string, number> = { ...(hand.commits ?? {}) };
    const key = String(seatIdx);
    const myCommit = commits[key] ?? 0;
    const toMatch = Number(hand.betToMatchCents ?? 0);
    const owe = Math.max(0, toMatch - myCommit);

    const starter = streetStarter(hand, seats);
    const nextSeat = nextActiveSeat(seats, hand, seatIdx);
    const actives = seats
      .filter((s) => !!(s?.occupiedBy || s?.uid))
      .map((s) => s.seatIndex)
      .sort((a, b) => a - b);

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
    // Mark the action as applied from the server (reduces dependence on client/rules timing)
    tx.update(actionRef, {
      applied: true,
      invalid: false,
      appliedAt: FieldValue.serverTimestamp(),
    });
  });
});

