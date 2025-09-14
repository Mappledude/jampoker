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

export const takeActionTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId, kind, expectedHandNo, expectedToActSeat, expectedUpdatedAt } = request.data || {};
  if (!tableId || !kind) throw new HttpsError('invalid-argument', 'missing-fields');
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const tableRef = db.doc(`tables/${tableId}`);

  await db.runTransaction(async (tx) => {
    const [handSnap, tableSnap] = await Promise.all([tx.get(handRef), tx.get(tableRef)]);
    const hand = handSnap.data();
    const table = tableSnap.data();
    if (!hand || !table) throw new HttpsError('failed-precondition', 'hand-or-table-missing');

    if (hand.handNo !== expectedHandNo) throw new HttpsError('aborted', 'stale-handno');
    if (
      expectedUpdatedAt &&
      +hand.updatedAt?.toMillis?.() !== +expectedUpdatedAt?.toMillis?.()
    ) {
      throw new HttpsError('aborted', 'stale-hand');
    }
    const mySeat = table.seats.findIndex((s: any) => s?.uid === request.auth?.uid);
    if (mySeat < 0) throw new HttpsError('permission-denied', 'not-seated');
    if (hand.toActSeat !== mySeat || expectedToActSeat !== mySeat) {
      throw new HttpsError('failed-precondition', 'not-your-turn');
    }

    const commits: Record<string, number> = { ...(hand.commits ?? {}) };
    const key = String(mySeat);
    const myCommit = commits[key] ?? 0;
    const toMatch = hand.betToMatchCents ?? 0;
    const owe = Math.max(0, toMatch - myCommit);

    let add = 0;
    if (kind === 'call') add = owe;
    else if (kind === 'check') add = 0;
    else throw new HttpsError('invalid-argument', 'bad-kind');

    commits[key] = myCommit + add;
    const nextSeat = nextLiveSeat(table.seats, hand, mySeat);

    tx.update(handRef, {
      commits,
      toActSeat: nextSeat,
      lastAggressorSeat: kind === 'raise' ? mySeat : hand.lastAggressorSeat ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
});

