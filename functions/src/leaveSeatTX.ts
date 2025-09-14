import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const db = getFirestore();

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
    const hand = handSnap.data();
    const user = userSnap.data();
    if (!table || !user) throw new HttpsError('failed-precondition', 'missing-data');

    const seatIdx = table.seats.findIndex((s: any) => s?.uid === uid);
    if (seatIdx < 0) throw new HttpsError('failed-precondition', 'not-seated');

    const seat = table.seats[seatIdx];
    const stackCents = seat.stackCents ?? 0;
    const wallet = (user.walletCents ?? 0) + stackCents;

    const seats = table.seats.slice();
    seats[seatIdx] = { seat: seatIdx, uid: null, stackCents: 0 };

    const handUpdate: any = {};
    if (hand && hand.toActSeat === seatIdx) {
      handUpdate.toActSeat = nextLiveSeat(seats, hand, seatIdx);
      handUpdate.updatedAt = FieldValue.serverTimestamp();
    }

    tx.update(userRef, { walletCents: wallet });
    tx.update(tableRef, { seats, activeSeatCount: Math.max(0, (table.activeSeatCount ?? 1) - 1) });
    if (handSnap.exists) tx.update(handRef, handUpdate);
  });
});

