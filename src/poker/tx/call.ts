import { enqueueAction } from '../../lib/poker/actions';

export async function call(
  db: any,
  tableId: string,
  seat: number,
  uid: string,
  handNo: number,
  amountCents?: number
): Promise<void> {
  await enqueueAction(db, tableId, seat, uid, handNo, {
    type: 'call',
    amountCents,
  });
}
