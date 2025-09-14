import { addDoc, collection, serverTimestamp } from 'firebase/firestore';

export async function fold(
  db: any,
  tableId: string,
  seat: number,
  uid: string
): Promise<void> {
  await addDoc(collection(db, `tables/${tableId}/actions`), {
    seat,
    type: 'fold',
    createdByUid: uid,
    createdAt: serverTimestamp(),
  });
}
