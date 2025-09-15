import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  updateDoc,
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
          await updateDoc(actionRef, {
            applied: true,
            appliedAt: serverTimestamp(),
          });
        } catch (err: any) {
          console.error('worker.apply.error', err);
          await updateDoc(actionRef, {
            applied: true,
            invalid: true,
            reason: err?.message || 'server-error',
            error: err?.code || null,
            appliedAt: serverTimestamp(),
          });
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', {
        code: err.code,
        message: err.message,
      });
    }
  );
}
