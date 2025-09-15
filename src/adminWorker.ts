import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
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

  if (window.jamlog) window.jamlog.push('worker.start', { tableId });

  return onSnapshot(
    q,
    async (snap) => {
      if (snap.empty) return;
      for (const docSnap of snap.docs) {
        const actionId = docSnap.id;
        try {
          await takeActionTX({ tableId, actionId });
          if (window.jamlog) window.jamlog.push('worker.cf.ok', { tableId, actionId });
        } catch (err) {
          const code = err?.code || 'unknown';
          const message = err?.message || String(err);
          console.error('worker.cf.error', { tableId, actionId, code, message });
          if (window.jamlog) window.jamlog.push('worker.cf.error', { tableId, actionId, code, message });
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', { code: err.code, message: err.message });
      if (window.jamlog) window.jamlog.push('worker.sub.error', { code: err.code, message: err.message });
    }
  );
}
