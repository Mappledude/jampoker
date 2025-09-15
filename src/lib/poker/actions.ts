import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';

export type PlayerAction = {
  type: 'check' | 'call' | 'bet' | 'raise' | 'fold';
  amountCents?: number; // For bet/raise, this is the *new* betToMatch level (total to match), not the delta
};

export async function enqueueAction(
  db: any,
  tableId: string,
  seat: number,
  createdByUid: string,
  handNo: number,
  actorUid: string,
  action: PlayerAction
): Promise<string> {
  const ref = doc(collection(db, `tables/${tableId}/actions`));
  await setDoc(ref, {
    handNo,
    seat,
    ...action,
    createdByUid,
    actorUid,
    createdAt: serverTimestamp(),
    clientTs: Date.now(),
    applied: false,
  });
  return ref.id;
}
