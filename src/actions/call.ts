import { getFunctions, httpsCallable } from 'firebase/functions';

const callCF = httpsCallable<{ tableId: string }, any>(getFunctions(), 'pokerCall');

export async function call(tableId: string): Promise<void> {
  await callCF({ tableId });
}
