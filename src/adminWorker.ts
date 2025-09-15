import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

export function startActionWorker(tableId: string) {
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
        const actionRef = docSnap.ref;

        try {
          await takeActionTX({ tableId, actionId: docSnap.id });
          // NOTE: CF already marks applied:true. Leaving this no-op.
          // If you prefer the worker to mark too (and you loosen rules), uncomment:
          // await updateDoc(actionRef, { applied: true, appliedAt: serverTimestamp() });
        } catch (err: any) {
          // If you loosen rules (see rules change below), you may mark invalid here:
          try {
            await updateDoc(actionRef, {
              applied: true,
              invalid: true,
              reason: err?.code || String(err),
              appliedAt: serverTimestamp(),
            });
          } catch {
            // ignore (rules may block client updates)
          }
          console.error('worker.apply.error', { tableId, actionId: docSnap.id, code: err?.code, message: err?.message });
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', { code: err.code, message: err.message });
    }
  );
}
