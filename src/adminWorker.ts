import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  doc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

function pushJamlog(type: string, ctx: Record<string, unknown>) {
  const jamlog = (globalThis as any)?.jamlog;
  if (jamlog && typeof jamlog.push === 'function') {
    jamlog.push(type, ctx);
  }
}

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
        const actionRef = doc(db, `tables/${tableId}/actions/${docSnap.id}`);

        try {
          console.debug('worker.apply.start', { tableId, actionId: docSnap.id });
          pushJamlog('worker.apply.start', { tableId, actionId: docSnap.id });
          await takeActionTX({ tableId, actionId: docSnap.id });
          console.debug('worker.apply.ok', { tableId, actionId: docSnap.id });
          pushJamlog('worker.apply.ok', { tableId, actionId: docSnap.id });
          await updateDoc(actionRef, { applied: true, appliedAt: serverTimestamp() });
        } catch (err: any) {
          console.error('worker.apply.fail', {
            tableId,
            actionId: docSnap.id,
            code: err?.code,
            message: err?.message,
          });
          pushJamlog('worker.apply.fail', {
            tableId,
            actionId: docSnap.id,
            code: err?.code ?? null,
            message: err?.message ?? String(err),
          });
          await updateDoc(actionRef, {
            applied: true,
            invalid: true,
            reason: err?.code || String(err),
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
