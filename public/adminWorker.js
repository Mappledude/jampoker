import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  getDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

export function startActionWorker(tableId) {
  const db = getFirestore();
  const functions = getFunctions();
  const takeActionTX = httpsCallable(functions, 'takeActionTX');

  const q = query(
    collection(db, `tables/${tableId}/actions`),
    where('applied', '==', false),
    orderBy('createdAt', 'asc'),
    limit(1)
  );

  return onSnapshot(
    q,
    async (snap) => {
      for (const docSnap of snap.docs) {
        const a = docSnap.data();
        const actionRef = docSnap.ref;
        const hsRef = doc(db, `tables/${tableId}/handState/current`);
        const hsSnap = await getDoc(hsRef);
        const hs = hsSnap.data();
        if (!hs || hs.toActSeat !== a.seat) {
          await updateDoc(actionRef, {
            applied: true,
            invalid: true,
            reason: 'not-your-turn',
            appliedAt: serverTimestamp(),
          });
          continue;
        }
        const seatUid = hs?.seats?.[a.seat]?.uid;
        if (a.actorUid && seatUid && a.actorUid !== seatUid) {
          console.warn('worker.apply.warn', {
            reason: 'seat-mismatch',
            actionId: docSnap.id,
            seat: a.seat,
            actorUid: a.actorUid,
            seatUid,
          });
        }
        try {
          await takeActionTX({
            tableId,
            action: {
              handNo: a.handNo,
              seat: a.seat,
              type: a.type,
              amountCents: a.amountCents ?? null,
              actorUid: a.actorUid,
              createdByUid: a.createdByUid,
            },
          });
          await updateDoc(actionRef, {
            applied: true,
            appliedAt: serverTimestamp(),
          });
          console.log('worker.apply.ok', { id: docSnap.id, type: a.type, seat: a.seat });
        } catch (err) {
          console.error('worker.apply.error', { id: docSnap.id, err: String(err) });
          await updateDoc(actionRef, {
            applied: true,
            invalid: true,
            reason: 'server-error',
            appliedAt: serverTimestamp(),
          });
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', { code: err.code, message: err.message });
    }
  );
}
