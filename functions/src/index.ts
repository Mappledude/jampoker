import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentWritten, onDocumentUpdated } from 'firebase-functions/v2/firestore';

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'us-central1' });

const AUTO_END_MS = 20000;
const DEFAULT_VARIANT_TIMEOUT_MS = 5000;

type Seat = {
  id: string;
  playerName?: string;
  seatNum?: number;
  satAt?: FirebaseFirestore.Timestamp;
};

async function getSeats(tx: FirebaseFirestore.Transaction, tableRef: FirebaseFirestore.DocumentReference) {
  const snap = await tx.get(tableRef.collection('seats'));
  const seats: Seat[] = [];
  snap.forEach(doc => seats.push({ id: doc.id, ...(doc.data() as any) }));
  return seats;
}

export const onSeatsChanged = onDocumentWritten('tables/{tableId}/seats/{playerId}', async (event) => {
  const tableId = event.params.tableId;
  const tableRef = db.collection('tables').doc(tableId);
  let newHandId: string | null = null;

  await db.runTransaction(async (tx) => {
    const tableSnap = await tx.get(tableRef);
    if (!tableSnap.exists) return;
    const table = tableSnap.data() || {};

    const seats = await getSeats(tx, tableRef);
    // sort by satAt and compact seat numbers
    seats.sort((a, b) => (a.satAt?.toMillis() || 0) - (b.satAt?.toMillis() || 0));
    seats.forEach((s, idx) => {
      if (s.seatNum !== idx) {
        tx.update(tableRef.collection('seats').doc(s.id), { seatNum: idx });
        s.seatNum = idx;
      }
    });
    const activeSeatCount = seats.length;

    const updates: any = { activeSeatCount };

    if (activeSeatCount >= 2 && !table.currentHandId) {
      let dealerSeat = seats.find(s => s.id === table.nextDealerId);
      if (!dealerSeat) dealerSeat = seats[0];
      const dealerId = dealerSeat?.id;
      const dealerName = dealerSeat?.playerName || '';
      const variant = table.nextVariantId || 'holdem';
      const handRef = tableRef.collection('hands').doc();
      tx.set(handRef, {
        variant,
        status: 'pending',
        dealerId,
        dealerName,
        startedAt: FieldValue.serverTimestamp(),
        sbCents: table.smallBlindCents,
        bbCents: table.bigBlindCents,
        potCents: 0
      });
      updates.currentHandId = handRef.id;
      updates.nextDealerId = dealerId;
      updates.nextDealerName = dealerName;
      newHandId = handRef.id;
    }

    tx.update(tableRef, updates);
  });

  if (newHandId) {
    setTimeout(() => {
      tableRef.collection('hands').doc(newHandId!).update({
        status: 'ended',
        endedAt: FieldValue.serverTimestamp()
      }).catch(() => {});
    }, AUTO_END_MS);
  }
});

export const onHandEnded = onDocumentUpdated('tables/{tableId}/hands/{handId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;
  if (before.status === 'ended' || after.status !== 'ended') return;

  const tableId = event.params.tableId;
  const tableRef = db.collection('tables').doc(tableId);
  let newHandId: string | null = null;
  let scheduleDefault = false;

  await db.runTransaction(async (tx) => {
    const tableSnap = await tx.get(tableRef);
    if (!tableSnap.exists) return;
    const table = tableSnap.data() || {};

    const seats = await getSeats(tx, tableRef);
    seats.sort((a, b) => (a.seatNum ?? 0) - (b.seatNum ?? 0));
    const activeSeatCount = seats.length;

    // find next dealer
    const currentIdx = seats.findIndex(s => s.id === after.dealerId);
    let nextDealer: Seat | undefined;
    for (let i = 1; i <= seats.length; i++) {
      const candidate = seats[(currentIdx + i) % seats.length];
      if (candidate) { nextDealer = candidate; break; }
    }

    const updates: any = {
      currentHandId: null,
      nextDealerId: nextDealer?.id || null,
      nextDealerName: nextDealer?.playerName || null,
      activeSeatCount
    };

    if (activeSeatCount >= 2) {
      if (table.nextVariantId) {
        const handRef = tableRef.collection('hands').doc();
        tx.set(handRef, {
          variant: table.nextVariantId,
          status: 'pending',
          dealerId: nextDealer?.id,
          dealerName: nextDealer?.playerName || '',
          startedAt: FieldValue.serverTimestamp(),
          sbCents: table.smallBlindCents,
          bbCents: table.bigBlindCents,
          potCents: 0
        });
        updates.currentHandId = handRef.id;
        updates.nextVariantId = null;
        newHandId = handRef.id;
      } else {
        scheduleDefault = true;
      }
    }

    tx.update(tableRef, updates);
  });

  if (newHandId) {
    setTimeout(() => {
      tableRef.collection('hands').doc(newHandId!).update({
        status: 'ended',
        endedAt: FieldValue.serverTimestamp()
      }).catch(() => {});
    }, AUTO_END_MS);
  } else if (scheduleDefault) {
    setTimeout(async () => {
      let createdId: string | null = null;
      await db.runTransaction(async (tx) => {
        const tableSnap = await tx.get(tableRef);
        if (!tableSnap.exists) return;
        const table = tableSnap.data() || {};
        if (table.currentHandId || table.nextVariantId) return;

        const seatsSnap = await tx.get(tableRef.collection('seats'));
        if (seatsSnap.size < 2) return;
        const seats: Seat[] = [];
        seatsSnap.forEach(doc => seats.push({ id: doc.id, ...(doc.data() as any) }));
        seats.sort((a, b) => (a.seatNum ?? 0) - (b.seatNum ?? 0));
        const dealer = seats.find(s => s.id === table.nextDealerId) || seats[0];
        const handRef = tableRef.collection('hands').doc();
        tx.set(handRef, {
          variant: 'holdem',
          status: 'pending',
          dealerId: dealer?.id,
          dealerName: dealer?.playerName || '',
          startedAt: FieldValue.serverTimestamp(),
          sbCents: table.smallBlindCents,
          bbCents: table.bigBlindCents,
          potCents: 0
        });
        tx.update(tableRef, { currentHandId: handRef.id });
        createdId = handRef.id;
      });
      if (createdId) {
        setTimeout(() => {
          tableRef.collection('hands').doc(createdId!).update({
            status: 'ended',
            endedAt: FieldValue.serverTimestamp()
          }).catch(() => {});
        }, AUTO_END_MS);
      }
    }, DEFAULT_VARIANT_TIMEOUT_MS);
  }
});

export const onVariantChosen = onDocumentUpdated('tables/{tableId}', async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after) return;
  if (before.nextVariantId === after.nextVariantId) return;

  const tableId = event.params.tableId;
  const tableRef = db.collection('tables').doc(tableId);
  let newHandId: string | null = null;

  await db.runTransaction(async (tx) => {
    const tableSnap = await tx.get(tableRef);
    if (!tableSnap.exists) return;
    const table = tableSnap.data() || {};
    if (!table.nextVariantId || table.currentHandId) return;

    const seatsSnap = await tx.get(tableRef.collection('seats'));
    if (seatsSnap.size < 2) return;
    const dealerSnap = await tx.get(tableRef.collection('seats').doc(table.nextDealerId));
    if (!dealerSnap.exists) return;
    const dealer = dealerSnap.data() as any;

    const handRef = tableRef.collection('hands').doc();
    tx.set(handRef, {
      variant: table.nextVariantId,
      status: 'pending',
      dealerId: table.nextDealerId,
      dealerName: table.nextDealerName || dealer.playerName || '',
      startedAt: FieldValue.serverTimestamp(),
      sbCents: table.smallBlindCents,
      bbCents: table.bigBlindCents,
      potCents: 0
    });
    tx.update(tableRef, { currentHandId: handRef.id, nextVariantId: null });
    newHandId = handRef.id;
  });

  if (newHandId) {
    setTimeout(() => {
      tableRef.collection('hands').doc(newHandId!).update({
        status: 'ended',
        endedAt: FieldValue.serverTimestamp()
      }).catch(() => {});
    }, AUTO_END_MS);
  }
});
