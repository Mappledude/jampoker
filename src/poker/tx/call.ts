import { addDoc, collection, serverTimestamp } from 'firebase/firestore';

export async function call(
  db: any,
  tableId: string,
  seat: number,
  uid: string,
  amountCents?: number
): Promise<void> {
  await addDoc(collection(db, `tables/${tableId}/actions`), {
    seat,
    type: 'call',
    amountCents,
    createdByUid: uid,
    createdAt: serverTimestamp(),
  });
}
