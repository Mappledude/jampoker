import { runTransaction, serverTimestamp } from 'firebase/firestore';
import { computeToCall, HandState, maybeAdvanceStreet } from '../handMath';

export async function call(db: any, handRef: any): Promise<void> {
  await runTransaction(db, async (tx: any) => {
    const snap = await tx.get(handRef);
    const hand = snap.data() as HandState;
    if (!hand) throw new Error('missing-hand');
    const seat = hand.toActSeat as number;
    const toCall = computeToCall(hand, seat);
    if (toCall <= 0) throw new Error('no-call');
    const newCommit = (hand.commits?.[seat] ?? 0) + toCall;
    const after: HandState = {
      ...hand,
      commits: { ...hand.commits, [seat]: newCommit },
    };
    const advance = maybeAdvanceStreet(after);
    tx.update(handRef, {
      [`commits.${seat}`]: newCommit,
      ...advance,
      updatedAt: serverTimestamp(),
    });
  });
}
