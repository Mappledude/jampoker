import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';

export type PlayerAction = {
  type: 'check' | 'call' | 'bet' | 'raise' | 'fold';
  amountCents?: number;
};

export async function enqueueAction(
  db: any,
  tableId: string,
  seat: number,
  createdByUid: string,
  handNo: number,
  actorUid: string,
  action: PlayerAction
) {
  const ref = doc(collection(db, `tables/${tableId}/actions`));
  await setDoc(ref, {
    handNo,
    seat,
    ...action,
    createdByUid,
    actorUid,
    createdAt: serverTimestamp(),
    applied: false,
    clientTs: Date.now(),
  });
}
