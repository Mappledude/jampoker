import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

const db = admin.firestore();

export const pokerCall = onCall({ cors: true }, async (req) => {
  const { tableId } = req.data ?? {};
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'sign in');
  if (!tableId) throw new HttpsError('invalid-argument', 'tableId required');

  await db.runTransaction(async (tx) => {
    const ref = db.doc(`tables/${tableId}/handState/current`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('failed-precondition', 'no-hand');
    const s = snap.data() as any;

    if (s.toActSeat !== s.sbSeat) {
      throw new HttpsError('failed-precondition', 'not-your-turn');
    }

    const betToMatch = s.betToMatchCents ?? 0;
    const commits = { ...(s.commits ?? {}) } as Record<string, number>;
    const key = String(s.sbSeat);
    const current = commits[key] ?? 0;
    const delta = Math.max(0, betToMatch - current);
    if (delta === 0) {
      return;
    }
    commits[key] = betToMatch;

    tx.update(ref, {
      commits,
      toActSeat: s.bbSeat,
      lastAggressorSeat: s.bbSeat,
      version: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastWriteBy: 'cf:pokerCall',
    });

    const auditRef = db.collection(`tables/${tableId}/audits`).doc();
    tx.set(auditRef, {
      at: admin.firestore.FieldValue.serverTimestamp(),
      by: uid,
      action: 'call',
      delta,
      fromCommit: current,
      toCommit: betToMatch,
      tableId,
    });

    logger.info('pokerCall.write', {
      tableId,
      fields: ['commits', 'toActSeat'],
      tag: 'cf',
    });
  });

  return { ok: true };
});

