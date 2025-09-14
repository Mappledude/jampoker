import { enqueueAction } from '../../lib/poker/actions';

export async function fold(
  db: any,
  tableId: string,
  seat: number,
  uid: string,
  handNo: number
): Promise<void> {
  await enqueueAction(db, tableId, seat, uid, handNo, uid, { type: 'fold' });
}
