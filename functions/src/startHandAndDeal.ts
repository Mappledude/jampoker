import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';

type Variant = 'holdem' | 'omaha';

const makeDeck = (): string[] => {
  const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  const suits = ['s', 'h', 'd', 'c'];
  const deck: string[] = [];
  for (const rank of ranks) {
    for (const suit of suits) deck.push(`${rank}${suit}`);
  }
  return deck;
};

const shuffleInPlace = (deck: string[]) => {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
};

const normalizeVariant = (value: unknown): Variant => {
  return value === 'omaha' ? 'omaha' : 'holdem';
};

const toSeatNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
};

const toCents = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
};

export const startHandAndDeal = onCall(async (request) => {
  const { tableId, variant } = request.data || {};
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'auth-required');
  if (!tableId || typeof tableId !== 'string') {
    throw new HttpsError('invalid-argument', 'missing-table');
  }

  const normalizedVariant = normalizeVariant(variant);

  const tableRef = db.doc(`tables/${tableId}`);
  const handRef = db.doc(`tables/${tableId}/handState/current`);
  const seatsCol = tableRef.collection('seats');

  const result = await db.runTransaction(async (tx) => {
    const [tableSnap, handSnap, seatsSnap] = await Promise.all([
      tx.get(tableRef),
      tx.get(handRef),
      tx.get(seatsCol),
    ]);

    if (!tableSnap.exists) {
      throw new HttpsError('not-found', 'table-not-found');
    }

    const tableData = tableSnap.data() as Record<string, unknown>;
    const tableAny = tableData as Record<string, any>;
    if ((tableAny.createdByUid as string | undefined) !== uid) {
      throw new HttpsError('permission-denied', 'not-table-admin');
    }

    const handData = handSnap.data() as Record<string, unknown> | undefined;
    if (handData?.street) {
      throw new HttpsError('failed-precondition', 'already-in-hand');
    }

    const occupiedSeats: Array<{ seatIndex: number; uid: string }> = [];
    seatsSnap.forEach((docSnap) => {
      const data = docSnap.data();
      const seatIndex = toSeatNumber(data?.seatIndex ?? docSnap.id);
      const seatUid = typeof data?.occupiedBy === 'string' ? data.occupiedBy : null;
      if (seatIndex != null && seatUid) {
        occupiedSeats.push({ seatIndex, uid: seatUid });
      }
    });

    occupiedSeats.sort((a, b) => a.seatIndex - b.seatIndex);
    if (occupiedSeats.length < 2) {
      throw new HttpsError('failed-precondition', 'not-enough-players');
    }

    const seatOrder = occupiedSeats.map((s) => s.seatIndex);
    const nextSeat = (arr: number[], current: number) => {
      const idx = arr.indexOf(current);
      const nextIdx = (idx + 1) % arr.length;
      return arr[nextIdx];
    };

    const previousDealer = toSeatNumber(handData?.dealerSeat);
    let dealerSeat: number;
    if (previousDealer != null && seatOrder.includes(previousDealer)) {
      dealerSeat = nextSeat(seatOrder, previousDealer);
    } else {
      dealerSeat = seatOrder[0];
    }

    const sbSeat = nextSeat(seatOrder, dealerSeat);
    const bbSeat = nextSeat(seatOrder, sbSeat);
    const toActSeat = seatOrder.length === 2 ? sbSeat : nextSeat(seatOrder, bbSeat);

    const nextHandNo = (typeof handData?.handNo === 'number' ? handData.handNo : 0) + 1;

    const blinds = (tableAny.blinds as Record<string, any>) || {};
    const sbCents = toCents(blinds?.sbCents ?? tableAny?.smallBlindCents);
    const bbCents = toCents(blinds?.bbCents ?? tableAny?.bigBlindCents);

    const commits: Record<string, number> = {
      [String(sbSeat)]: sbCents,
      [String(bbSeat)]: bbCents,
    };

    const potCents = Object.values(commits).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

    const deck = makeDeck();
    shuffleInPlace(deck);

    const cardsPerSeat = normalizedVariant === 'omaha' ? 4 : 2;
    const dealingOrder: number[] = [];
    let cursor = sbSeat;
    do {
      dealingOrder.push(cursor);
      cursor = nextSeat(seatOrder, cursor);
    } while (cursor !== sbSeat);

    const seatCards = new Map<number, string[]>();
    dealingOrder.forEach((seat) => seatCards.set(seat, []));

    let deckIndex = 0;
    for (let round = 0; round < cardsPerSeat; round += 1) {
      for (const seat of dealingOrder) {
        const card = deck[deckIndex];
        deckIndex += 1;
        if (!card) {
          throw new HttpsError('internal', 'deck-exhausted');
        }
        seatCards.get(seat)!.push(card);
      }
    }

    const players = occupiedSeats.map(({ seatIndex, uid: seatUid }) => ({ seat: seatIndex, uid: seatUid }));

    const privateWrites = players.map(({ seat, uid: seatUid }) => {
      const cards = seatCards.get(seat) ?? [];
      const privateRef = tableRef
        .collection('hands')
        .doc(String(nextHandNo))
        .collection('private')
        .doc(String(seat));
      tx.set(privateRef, {
        seat,
        uid: seatUid,
        cards,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { seat, count: cards.length };
    });

    tx.set(handRef, {
      handNo: nextHandNo,
      variant: normalizedVariant,
      street: 'preflop',
      toActSeat,
      commits,
      betToMatchCents: bbCents,
      potCents,
      community: [],
      dealerSeat,
      sbSeat,
      bbSeat,
      lastAggressorSeat: null,
      lastRaiseSizeCents: 0,
      lastRaiseToCents: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      version: FieldValue.increment(1),
      lastWriteBy: 'cf:startHandAndDeal',
    });

    return {
      handNo: nextHandNo,
      variant: normalizedVariant,
      players,
      privateWrites,
    };
  });

  logger.info('deal.start', {
    tableId,
    variant: result.variant,
    handNo: result.handNo,
    players: result.players,
  });

  result.privateWrites.forEach((entry) => {
    logger.info('deal.hole', { tableId, handNo: result.handNo, seat: entry.seat, count: entry.count });
  });

  logger.info('deal.done', { tableId, handNo: result.handNo });

  return { ok: true, handNo: result.handNo };
});
