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

  if ((window as any).jamlog) (window as any).jamlog.push('worker.start', { tableId });

  return onSnapshot(
    q,
    async (snap) => {
      if (snap.empty) return;

      for (const docSnap of snap.docs) {
        const actionId = docSnap.id;

        // Call the Cloud Function with { tableId, actionId }.
        // The CF validates turn/actor, updates handState, and marks the action as applied.
        try {
          await takeActionTX({ tableId, actionId });

          if ((window as any).jamlog) {
            (window as any).jamlog.push('worker.cf.ok', { tableId, actionId });
          }
        } catch (err: any) {
          // Do NOT try to write to /actions here (rules disallow updates).
          const code = err?.code || 'unknown';
          const message = err?.message || String(err);
          console.error('worker.cf.error', { tableId, actionId, code, message });
          if ((window as any).jamlog) {
            (window as any).jamlog.push('worker.cf.error', { tableId, actionId, code, message });
          }
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', { code: err.code, message: err.message });
      if ((window as any).jamlog) {
        (window as any).jamlog.push('worker.sub.error', { code: err.code, message: err.message });
      }
    }
  );
}

