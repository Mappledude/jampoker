import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

function nextActiveSeat(seats: any[], hand: any, start: number): number {
  const total = seats.length;
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  for (let i = 1; i <= total; i++) {
    const idx = (start + i) % total;
    const seat = seats[idx];
    if (seat?.uid && !folded.has(idx)) return idx;
  }
  return start;
}

function activeSeats(seats: any[], hand: any): number[] {
  const folded = new Set((hand?.folded ?? []).map((n: any) => Number(n)));
  return seats
    .map((s: any, i: number) => (s?.uid && !folded.has(i) ? i : -1))
    .filter((i: number) => i >= 0);
}

function sumCommits(commits: Record<string, number>): number {
  return Object.values(commits || {}).reduce((m, v) => m + Number(v || 0), 0);
}

function streetStarter(seats: any[], hand: any): number {
  if (hand.street === 'preflop') {
    const bb = typeof hand.bbSeat === 'number' ? hand.bbSeat : hand.dealerSeat;
    return nextActiveSeat(seats, hand, bb);
  }
  return nextActiveSeat(seats, hand, hand.dealerSeat ?? 0);
}

function nextStreet(street: string): string {
  switch (street) {
    case 'preflop':
      return 'flop';
    case 'flop':
      return 'turn';
    case 'turn':
      return 'river';
    default:
      return 'showdown';
  }
}

function advanceStreet(hand: any, seats: any[]) {
  const street = nextStreet(hand.street);
  const toAct = street === 'showdown' ? null : streetStarter(seats, hand);
  return {
    street,
    betToMatchCents: 0,
    lastAggressorSeat: null,
    toActSeat: toAct,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export const takeActionTX = onCall(async (request: CallableRequest<any>) => {
  const { tableId, kind, expectedHandNo, expectedToActSeat, expectedUpdatedAt } = request.data || {};
  if (!tableId || !kind) throw new HttpsError('invalid-argument', 'missing-fields');
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const tableRef = db.doc(`tables/${tableId}`);

  await db.runTransaction(async (tx) => {
    const [handSnap, tableSnap] = await Promise.all([tx.get(handRef), tx.get(tableRef)]);
    const hand = handSnap.data();
    const table = tableSnap.data();
    if (!hand || !table) throw new HttpsError('failed-precondition', 'hand-or-table-missing');

    if (hand.handNo !== expectedHandNo) throw new HttpsError('aborted', 'stale-handno');
    if (
      expectedUpdatedAt &&
      +hand.updatedAt?.toMillis?.() !== +expectedUpdatedAt?.toMillis?.()
    ) {
      throw new HttpsError('aborted', 'stale-hand');
    }
    const mySeat = table.seats.findIndex((s: any) => s?.uid === request.auth?.uid);
    if (mySeat < 0) throw new HttpsError('permission-denied', 'not-seated');
    if (hand.toActSeat !== mySeat || expectedToActSeat !== mySeat) {
      throw new HttpsError('failed-precondition', 'not-your-turn');
    }

    const commits: Record<string, number> = { ...(hand.commits ?? {}) };
    const key = String(mySeat);
    const myCommit = commits[key] ?? 0;
    const toMatch = hand.betToMatchCents ?? 0;
    const owe = Math.max(0, toMatch - myCommit);

    const startSeat = streetStarter(table.seats, hand);
    const nextSeat = nextActiveSeat(table.seats, hand, mySeat);
    const actives = activeSeats(table.seats, hand);

    let updates: any = { updatedAt: FieldValue.serverTimestamp() };

    if (kind === 'call') {
      if (mySeat !== hand.toActSeat) {
        throw new HttpsError('failed-precondition', 'cannot-call');
      }
      if (owe <= 0) {
        // treat as check when nothing owed
        updates.potCents = sumCommits(commits);
        if (nextSeat === startSeat) {
          updates = { ...updates, ...advanceStreet(hand, table.seats) };
        } else {
          updates.toActSeat = nextSeat;
        }
      } else {
        commits[key] = myCommit + owe;
        updates.commits = commits;
        updates.potCents = sumCommits(commits);
        const allMatched = actives.every((s) => (commits[String(s)] ?? 0) >= toMatch);
        if (allMatched && nextSeat === startSeat) {
          updates = { ...updates, ...advanceStreet(hand, table.seats) };
        } else {
          updates.toActSeat = nextSeat;
        }
      }
    } else if (kind === 'check') {
      if (owe > 0 || mySeat !== hand.toActSeat) {
        throw new HttpsError('failed-precondition', 'cannot-check');
      }
      updates.potCents = sumCommits(commits);
      if (nextSeat === startSeat) {
        updates = { ...updates, ...advanceStreet(hand, table.seats) };
      } else {
        updates.toActSeat = nextSeat;
      }
    } else {
      throw new HttpsError('invalid-argument', 'bad-kind');
    }

    tx.update(handRef, updates);
  });
});

