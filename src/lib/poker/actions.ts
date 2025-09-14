import { addDoc, collection, serverTimestamp } from 'firebase/firestore';

export type PlayerAction = {
  type: 'check' | 'call' | 'bet' | 'raise' | 'fold';
  amountCents?: number;
};

export async function enqueueAction(
  db: any,
  tableId: string,
  seat: number,
  uid: string,
  handNo: number,
  action: PlayerAction
) {
  await addDoc(collection(db, `tables/${tableId}/actions`), {
    handNo,
    seat,
    ...action,
    createdByUid: uid,
    createdAt: serverTimestamp(),
  });
}
