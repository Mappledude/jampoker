import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

function nextStreet(street: string) {
  return street === 'preflop' ? 'flop' : street === 'flop' ? 'turn' : street === 'turn' ? 'river' : 'showdown';
}
function nextActiveSeat(seats: any[], start: number): number | null {
  for (let step = 1; step <= 9; step++) {
    const idx = (start + step) % 9;
    const s = seats[idx];
    if (s?.uid) return idx;
  }
  return null;
}
function streetStarter(hand: any, seats: any[]) {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : hand.dealerSeat ?? 0;
    return nextActiveSeat(seats, bb);
  }
  return nextActiveSeat(seats, hand.dealerSeat ?? 0);
}

export const forceAdvanceStreet = onCall(async (req) => {
  const { tableId } = req.data || {};
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');
  if (!tableId) throw new HttpsError('invalid-argument', 'missing-table');

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);

  await db.runTransaction(async (tx) => {
    const [tSnap, hSnap] = await Promise.all([tx.get(tableRef), tx.get(handRef)]);
    const table = tSnap.data() as any;
    const hand = hSnap.data() as any;
    if (!table || !hand) throw new HttpsError('failed-precondition', 'missing-docs');
    if (table.createdByUid !== uid) throw new HttpsError('permission-denied', 'admin-only');

    const seats = (table.seats as any[]) ?? [];
    const street = nextStreet(hand.street);
    const toActSeat = street === 'showdown' ? null : streetStarter(hand, seats);

    tx.update(handRef, {
      street,
      betToMatchCents: 0,
      lastAggressorSeat: null,
      toActSeat,
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      lastActionId: 'admin-force-next-street',
    });
  });

  return { ok: true };
});
