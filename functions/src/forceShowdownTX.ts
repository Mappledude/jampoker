import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { db } from './admin';

export const forceShowdownTX = onCall(async (request) => {
  const { tableId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');
  if (!tableId || typeof tableId !== 'string') {
    throw new HttpsError('invalid-argument', 'missing-table');
  }

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);

  await db.runTransaction(async (tx) => {
    const [tableSnap, handSnap] = await Promise.all([tx.get(tableRef), tx.get(handRef)]);

    if (!tableSnap.exists) throw new HttpsError('failed-precondition', 'table-missing');
    if (!handSnap.exists) throw new HttpsError('failed-precondition', 'hand-missing');

    const table = tableSnap.data() as Record<string, unknown>;
    const hand = handSnap.data() as Record<string, unknown>;

    if (table.createdByUid !== uid) throw new HttpsError('permission-denied', 'admin-only');

    const handNo = typeof hand.handNo === 'number' ? hand.handNo : null;
    const street = typeof hand.street === 'string' ? hand.street : null;
    if (!street || street === 'showdown') return;

    tx.update(handRef, {
      street: 'showdown',
      betToMatchCents: 0,
      commits: {},
      lastAggressorSeat: null,
      lastRaiseSizeCents: 0,
      lastRaiseToCents: 0,
      toActSeat: null,
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      lastWriteBy: 'cf:forceShowdownTX',
    });

    logger.info('showdown.force', { tableId, handNo, from: street });
  });

  return { ok: true };
});
