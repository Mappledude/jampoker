import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

export const startHand = onCall(async (request) => {
  const { tableId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');
  if (!tableId) throw new HttpsError('invalid-argument', 'missing-table');

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const seatsCol = tableRef.collection('seats');

  const result = await db.runTransaction(async (tx) => {
    const [handSnap, seatsSnap, tableSnap] = await Promise.all([
      tx.get(handRef),
      tx.get(seatsCol),
      tx.get(tableRef),
    ]);

    const hand = handSnap.data() as any;
    const nextHandNo = (typeof hand?.handNo === 'number' ? hand.handNo : 0) + 1;
    if (hand?.handNo === nextHandNo) {
      // Idempotent: hand already exists for this hand number
      return { ok: true };
    }
    if (hand?.street) {
      // Hand already started; idempotent return
      return { ok: true };
    }

    const occupied: number[] = [];
    seatsSnap.forEach((d) => {
      const data = d.data();
      if (data?.occupiedBy) occupied.push(data.seatIndex);
    });
    occupied.sort((a, b) => a - b);

    if (occupied.length < 2) {
      return { ok: false, reason: 'not-enough-players' };
    }

    const next = (arr: number[], val: number) => arr[(arr.indexOf(val) + 1) % arr.length];
    let dealer: number;
    if (hand && occupied.includes(hand.dealerSeat)) dealer = next(occupied, hand.dealerSeat);
    else dealer = occupied[0];
    const sbSeat = next(occupied, dealer);
    const bbSeat = next(occupied, sbSeat);
    const toActSeat = next(occupied, bbSeat);
    const handNo = nextHandNo;

    const table = tableSnap.data() as any || {};
    const sb = table?.blinds?.sbCents || 0;
    const bb = table?.blinds?.bbCents || 0;
    const commits: Record<string, number> = {};
    commits[String(sbSeat)] = sb;
    commits[String(bbSeat)] = bb;

    tx.set(handRef, {
      handNo,
      dealerSeat: dealer,
      sbSeat,
      bbSeat,
      toActSeat,
      street: 'preflop',
      betToMatchCents: bb,
      commits,
      lastAggressorSeat: bbSeat,
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      lastWriteBy: 'cf:startHand',
    }, { merge: true });

    return { ok: true };
  });

  if (!result.ok) {
    throw new HttpsError('failed-precondition', result.reason || '');
  }

  return { ok: true };
});

