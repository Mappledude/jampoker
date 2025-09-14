import { runTransaction, serverTimestamp } from 'firebase/firestore';
import { computeToCall, HandState, maybeAdvanceStreet } from '../handMath';

export async function check(db: any, handRef: any): Promise<void> {
  await runTransaction(db, async (tx: any) => {
    const snap = await tx.get(handRef);
    const hand = snap.data() as HandState;
    if (!hand) throw new Error('missing-hand');
    const seat = hand.toActSeat;
    const toCall = computeToCall(hand, seat ?? -1);
    if (toCall > 0) throw new Error('now-must-call');
    const advance = maybeAdvanceStreet(hand);
    tx.update(handRef, { ...advance, updatedAt: serverTimestamp() });
  });
}
