import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { applyAction, HandState, Action } from './lib/engine';

export const onActionCreate = onDocumentCreated(
  { document: 'tables/{tableId}/actions/{actionId}', region: 'us-central1' },
  async (event) => {
    const action = event.data?.data() as Action | undefined;
    if (!action) return;
    const { tableId } = event.params;
    const hsRef = db.doc(`tables/${tableId}/handState/current`);
    const actionRef = event.data!.ref;

    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(hsRef);
        if (!snap.exists) {
          tx.update(actionRef, { status: 'rejected', reason: 'missing-hand' });
          return;
        }
        const state = snap.data() as HandState;
        if (state.handNo !== action.handNo || state.toActSeat !== action.seat) {
          tx.update(actionRef, {
            status: 'rejected',
            reason: 'not-your-turn',
            expected: state.toActSeat,
          });
          return;
        }
        const next = applyAction({ ...state }, action);
        next.version = (state.version || 0) + 1;
        (next as any).updatedAt = FieldValue.serverTimestamp();
        tx.update(hsRef, next as any);
        tx.update(actionRef, { status: 'applied' });
      });
    } catch (e: any) {
      await actionRef.update({ status: 'rejected', reason: e.message || 'error' });
    }
  }
);
