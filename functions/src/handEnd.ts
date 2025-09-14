import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { db } from './admin';

export const onHandEndCleanup = onDocumentUpdated(
  { region: 'us-central1', document: 'tables/{tableId}/handState/current' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.street === 'showdown' || after.street !== 'showdown') return;

    const tableId = event.params.tableId;
    const tableRef = db.doc(`tables/${tableId}`);

    await db.runTransaction(async (tx) => {
      const tableSnap = await tx.get(tableRef);
      if (!tableSnap.exists) return;
      const table = tableSnap.data() as any;
      const seats: any[] = table.seats || [];
      const leaving = seats
        .map((s, i) => ({ ...s, seat: i }))
        .filter((s) => s?.leaving && s.uid);
      if (leaving.length === 0) return;

      const userRefs = leaving.map((s) => db.doc(`users/${s.uid}`));
      const userSnaps = await Promise.all(userRefs.map((r) => tx.get(r)));

      leaving.forEach((s, idx) => {
        const data = userSnaps[idx].data() || {};
        const bank = (data.bankCents ?? 0) + (s.stackCents ?? 0);
        tx.update(userRefs[idx], { bankCents: bank });
        seats[s.seat] = { seat: s.seat, uid: null, stackCents: 0 };
      });

      const activeSeatCount = seats.filter((s) => s?.uid).length;
      tx.update(tableRef, { seats, activeSeatCount });
    });
  }
);
