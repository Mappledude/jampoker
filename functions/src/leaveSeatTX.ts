import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

function nextLiveSeat(seats: any[], hand: any, start: number): number {
  const total = seats.length;
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  for (let i = 1; i <= total; i++) {
    const idx = (start + i) % total;
    const seat = seats[idx];
    if (seat?.uid && !folded.has(idx)) return idx;
  }
  return start;
}

export const leaveSeatTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId } = request.data || {};
  if (!tableId) throw new HttpsError('invalid-argument', 'missing-table');
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const userRef = db.doc(`users/${uid}`);

  await db.runTransaction(async (tx) => {
    const [tableSnap, handSnap, userSnap] = await Promise.all([
      tx.get(tableRef),
      tx.get(handRef),
      tx.get(userRef),
    ]);

    const table = tableSnap.data();
    const hand = handSnap.data() as any;
    const user = userSnap.data();
    if (!table || !user) throw new HttpsError('failed-precondition', 'missing-data');

    const seatIdx = table.seats.findIndex((s: any) => s?.uid === uid);
    if (seatIdx < 0) throw new HttpsError('failed-precondition', 'not-seated');

    const seat = table.seats[seatIdx];
    const stackCents = seat.stackCents ?? 0;

    const seats = table.seats.slice();

    if (!handSnap.exists) {
      const bank = (user.bankCents ?? 0) + stackCents;
      seats[seatIdx] = { seat: seatIdx, uid: null, stackCents: 0 };
      tx.update(userRef, { bankCents: bank });
      tx.update(tableRef, {
        seats,
        activeSeatCount: Math.max(0, (table.activeSeatCount ?? 1) - 1),
      });
      return;
    }

    const handUpdate: any = { updatedAt: FieldValue.serverTimestamp() };
    const folded = new Set((hand.folded ?? []).map((n: any) => Number(n)));
    if (!folded.has(seatIdx)) handUpdate.folded = FieldValue.arrayUnion(seatIdx);
    if (hand.toActSeat === seatIdx) {
      handUpdate.toActSeat = nextLiveSeat(seats, hand, seatIdx);
    }
    seats[seatIdx] = { ...seat, leaving: true, sittingOut: true };
    tx.update(handRef, handUpdate);
    tx.update(tableRef, { seats });
  });
});

