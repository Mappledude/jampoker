import { addDoc, collection, serverTimestamp } from 'firebase/firestore';

export async function check(
  db: any,
  tableId: string,
  seat: number,
  uid: string
): Promise<void> {
  await addDoc(collection(db, `tables/${tableId}/actions`), {
    seat,
    type: 'check',
    createdByUid: uid,
    createdAt: serverTimestamp(),
  });
}
