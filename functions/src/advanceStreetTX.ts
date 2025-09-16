import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { db } from './admin';

type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

interface DeckDoc {
  seed?: number;
  remaining?: unknown;
  burned?: unknown;
}

const STREET_ORDER: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown'];

const nextStreet = (street: Street): Street => {
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
};

const toSeatNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};

const buildSeatArray = (table: any): any[] => {
  if (!table) return [];
  if (Array.isArray(table.seats)) return table.seats;
  if (Array.isArray(table.activeSeats)) return table.activeSeats;
  return [];
};

const isSeatOccupied = (seat: any, index: number, folded: Set<number>): boolean => {
  const occupant =
    typeof seat?.uid === 'string'
      ? seat.uid
      : typeof seat?.occupiedBy === 'string'
        ? seat.occupiedBy
        : null;
  if (!occupant) return false;
  return !folded.has(index);
};

const firstSeatLeftOfDealer = (seats: any[], dealerSeat: number | null, folded: Set<number>): number | null => {
  if (!seats.length || dealerSeat == null || dealerSeat < 0) return null;
  const total = seats.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (dealerSeat + step) % total;
    if (isSeatOccupied(seats[idx], idx, folded)) return idx;
  }
  return null;
};

const normalizeCommunity = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((card) => typeof card === 'string');
};

const normalizeDeckArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((card) => typeof card === 'string');
};

export const advanceStreetTX = onCall(async (request) => {
  const { tableId } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');
  if (!tableId || typeof tableId !== 'string') {
    throw new HttpsError('invalid-argument', 'missing-table');
  }

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);

  await db.runTransaction(async (tx) => {
    const [tableSnap, handSnap] = await Promise.all([tx.get(tableRef), tx.get(handRef)]);

    if (!tableSnap.exists) throw new HttpsError('failed-precondition', 'table-missing');
    if (!handSnap.exists) throw new HttpsError('failed-precondition', 'hand-missing');

    const table = tableSnap.data() as Record<string, unknown>;
    const hand = handSnap.data() as Record<string, unknown>;

    if (table.createdByUid !== uid) throw new HttpsError('permission-denied', 'admin-only');

    const handNo = typeof hand.handNo === 'number' ? hand.handNo : null;
    if (handNo == null) throw new HttpsError('failed-precondition', 'hand-no-missing');

    const rawStreet = typeof hand.street === 'string' ? (hand.street as Street) : null;
    if (!rawStreet || !STREET_ORDER.includes(rawStreet)) {
      throw new HttpsError('failed-precondition', 'street-invalid');
    }

    if (rawStreet === 'showdown') {
      throw new HttpsError('failed-precondition', 'hand-complete');
    }

    const deckRef = db.doc(`tables/${tableId}/hands/${String(handNo)}/deck`);
    const deckSnap = await tx.get(deckRef);
    if (!deckSnap.exists) throw new HttpsError('failed-precondition', 'deck-missing');
    const deckData = deckSnap.data() as DeckDoc;

    const remaining = normalizeDeckArray(deckData.remaining);
    const burned = normalizeDeckArray(deckData.burned);

    const from = rawStreet;
    const to = nextStreet(from);

    logger.info('street.advance.start', { tableId, handNo, from, to });

    if (from === 'river') {
      tx.update(handRef, {
        street: to,
        betToMatchCents: 0,
        commits: {},
        lastAggressorSeat: null,
        lastRaiseSizeCents: 0,
        lastRaiseToCents: 0,
        toActSeat: null,
        updatedAt: FieldValue.serverTimestamp(),
        version: FieldValue.increment(1),
        lastWriteBy: 'cf:advanceStreetTX',
      });
      logger.info('street.advance.done', { to });
      return;
    }

    const needed = 1 + (from === 'preflop' ? 3 : 1);
    if (remaining.length < needed) {
      throw new HttpsError('failed-precondition', 'deck-exhausted');
    }

    const burnCard = remaining.shift();
    if (!burnCard) throw new HttpsError('failed-precondition', 'deck-empty-burn');
    burned.push(burnCard);

    const dealCount = from === 'preflop' ? 3 : 1;
    const dealt: string[] = [];
    for (let i = 0; i < dealCount; i += 1) {
      const card = remaining.shift();
      if (!card) throw new HttpsError('failed-precondition', 'deck-empty-deal');
      dealt.push(card);
    }

    const existingCommunity = normalizeCommunity(hand.community);
    const nextCommunity = from === 'preflop' ? dealt : existingCommunity.concat(dealt);

    const folded = new Set((Array.isArray(hand.folded) ? hand.folded : []).map((n: any) => Number(n)).filter((n) => Number.isInteger(n)));
    const dealerSeat = toSeatNumber(hand.dealerSeat);
    const seats = buildSeatArray(table);
    const toActSeat = firstSeatLeftOfDealer(seats, dealerSeat, folded);

    tx.update(deckRef, {
      remaining,
      burned,
      updatedAt: FieldValue.serverTimestamp(),
    });

    tx.update(handRef, {
      street: to,
      community: nextCommunity,
      betToMatchCents: 0,
      commits: {},
      lastAggressorSeat: null,
      lastRaiseSizeCents: 0,
      lastRaiseToCents: 0,
      toActSeat,
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      lastWriteBy: 'cf:advanceStreetTX',
    });

    logger.info('deal.community', { to, cardsDealt: dealt });
    logger.info('street.advance.done', { to });
  });

  return { ok: true };
});
