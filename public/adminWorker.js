import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
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

  if (window.jamlog) window.jamlog.push('worker.start', { tableId });

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

          if (window.jamlog) {
            window.jamlog.push('worker.cf.ok', { tableId, actionId });
          }
        } catch (err) {
          // Do NOT try to write to /actions here (rules disallow updates).
          const code = err?.code || 'unknown';
          const message = err?.message || String(err);
          console.error('worker.cf.error', { tableId, actionId, code, message });
          if (window.jamlog) {
            window.jamlog.push('worker.cf.error', { tableId, actionId, code, message });
          }
        }
      }
    },
    (err) => {
      console.error('srv.action.listener_error', { code: err.code, message: err.message });
      if (window.jamlog) {
        window.jamlog.push('worker.sub.error', { code: err.code, message: err.message });
      }
    }
  );
}

