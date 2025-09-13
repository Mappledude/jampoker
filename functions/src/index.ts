// Cloud Functions: auto-start hands, dealer rotation, next-dealer variant
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction, CollectionReference } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten, onDocumentUpdated, onDocumentCreated } from "firebase-functions/v2/firestore";

initializeApp();
const db = getFirestore();

// Simple HTTP ping for sanity checks
export const ping = onRequest({ region: "us-central1" }, (_req, res) => {
  res.status(200).send("pong");
});

interface SeatInfo {
  playerId: string;
  playerName: string;
  seatNum: number;
  chipStackCents: number;
}

async function getActiveSeats(tx: Transaction, tableRef: DocumentReference): Promise<SeatInfo[]> {
  const seatsSnap = await tx.get(tableRef.collection("seats"));
  const seats: SeatInfo[] = [];
  seatsSnap.forEach((s) => {
    const d = s.data();
    if (d?.active) {
      seats.push({
        playerId: s.id,
        playerName: d.playerName || "",
        seatNum: typeof d.seatNum === "number" ? d.seatNum : -1,
        chipStackCents: typeof d.chipStackCents === "number" ? d.chipStackCents : 0,
      });
    }
  });

  let needsFix = false;
  const sorted = seats.slice().sort((a, b) => a.seatNum - b.seatNum);
  sorted.forEach((s, idx) => {
    if (s.seatNum !== idx) needsFix = true;
  });
  if (needsFix) {
    sorted.forEach((s, idx) => {
      tx.update(tableRef.collection("seats").doc(s.playerId), { seatNum: idx });
      s.seatNum = idx;
    });
  }
  return sorted;
}

function pickInitialDealer(seats: SeatInfo[], nextDealerId?: string | null): string | null {
  if (nextDealerId && seats.some((s) => s.playerId === nextDealerId)) return nextDealerId;
  return seats[0]?.playerId ?? null;
}

function rotateDealer(seats: SeatInfo[], currentDealerId: string): string {
  if (seats.length === 0) return currentDealerId;
  const idx = seats.findIndex((s) => s.playerId === currentDealerId);
  if (idx === -1) return seats[0].playerId;
  return seats[(idx + 1) % seats.length].playerId;
}

function makeDeck(): string[] {
  const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
  const suits = ["s", "h", "d", "c"];
  const deck: string[] = [];
  for (const r of ranks) {
    for (const s of suits) deck.push(r + s);
  }
  return deck;
}

function shuffleInPlace(deck: string[], _seed?: number) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function draw(hand: any, n: number): string[] {
  const deck: string[] = hand.deck || [];
  let idx: number = hand.deckIndex || 0;
  const cards = deck.slice(idx, idx + n);
  hand.deckIndex = idx + cards.length;
  return cards;
}

function nextSeat(
  seats: SeatInfo[],
  startSeatNum: number,
  folded: Record<string, true>,
  chipMap: Record<string, number>
): number {
  const count = seats.length;
  for (let i = 1; i <= count; i++) {
    const seat = seats[(startSeatNum + i) % count];
    if (!seat) continue;
    if (folded[seat.playerId]) continue;
    const chips = chipMap[seat.playerId] ?? seat.chipStackCents;
    if (chips <= 0) continue;
    return seat.seatNum;
  }
  return startSeatNum;
}

function firstPostflopActor(
  dealerSeatNum: number,
  seats: SeatInfo[],
  folded: Record<string, true>,
  chipMap: Record<string, number>
): number {
  return nextSeat(seats, dealerSeatNum, folded, chipMap);
}

function highestContribution(contrib: Record<string, number> = {}): number {
  return Object.values(contrib).reduce((m, v) => (v > m ? v : m), 0);
}

function toCallFor(contrib: Record<string, number>, playerId: string): number {
  const highest = highestContribution(contrib);
  const cur = contrib[playerId] || 0;
  return Math.max(0, highest - cur);
}

function countRemainingPlayers(
  folded: Record<string, true>,
  activePlayerIds: string[]
): number {
  return activePlayerIds.filter((id) => !folded[id]).length;
}

async function settlePotToWinnerTx(
  tx: Transaction,
  tableRef: DocumentReference,
  handRef: DocumentReference,
  winnerPlayerId: string
) {
  const [seatSnap, handSnap] = await Promise.all([
    tx.get(tableRef.collection("seats").doc(winnerPlayerId)),
    tx.get(handRef),
  ]);
  const seatChips = seatSnap.data()?.chipStackCents || 0;
  const pot = handSnap.data()?.potCents || 0;
  tx.update(tableRef.collection("seats").doc(winnerPlayerId), {
    chipStackCents: seatChips + pot,
  });
  tx.update(handRef, { potCents: 0 });
}

async function createHandTx(tx: Transaction, tableRef: DocumentReference, data: any) {
  const handRef = tableRef.collection("hands").doc();
  tx.set(handRef, data);
  tx.update(tableRef, { currentHandId: handRef.id });
  return handRef.id;
}

// Trigger: seat changes -> maybe create a new hand
export const onSeatsChanged = onDocumentWritten(
  { region: "us-central1", document: "tables/{tableId}/seats/{playerId}" },
  async (event) => {
    const tableId = event.params.tableId;
    const tableRef = db.collection("tables").doc(tableId);

    await db.runTransaction(async (tx) => {
      const seats = await getActiveSeats(tx, tableRef);

      const tableSnap = await tx.get(tableRef);
      if (!tableSnap.exists) return;
      const table = tableSnap.data() as any;
      if (!table.active) return;
      if (seats.length < 2) return;
      if (table.currentHandId) return;

      const dealerId = pickInitialDealer(seats, table.nextDealerId);
      if (!dealerId) return;
      const dealer = seats.find((s) => s.playerId === dealerId);
      const variant = table.nextVariantId ?? "holdem";

      await createHandTx(tx, tableRef, {
        variant,
        status: "pending",
        dealerId,
        dealerName: dealer?.playerName || "",
        startedAt: FieldValue.serverTimestamp(),
        sbCents: table.smallBlindCents,
        bbCents: table.bigBlindCents,
        potCents: 0,
      });

      const nextAfter = rotateDealer(seats, dealerId);
      const nextName = seats.find((s) => s.playerId === nextAfter)?.playerName || "";
      tx.update(tableRef, {
        nextDealerId: nextAfter,
        nextDealerName: nextName,
        nextVariantId: null,
      });
    });
  }
);

async function deleteCollection(
  ref: CollectionReference,
  batchSize: number
): Promise<number> {
  let deleted = 0;
  while (true) {
    const snap = await ref.limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;
    if (snap.size < batchSize) break;
  }
  return deleted;
}

async function deleteTable(tableId: string) {
  const tableRef = db.collection("tables").doc(tableId);
  const deletedSeats = await deleteCollection(
    tableRef.collection("seats"),
    200
  );
  const deletedHands = await deleteCollection(
    tableRef.collection("hands"),
    100
  );
  await tableRef.delete();
  return { deletedSeats, deletedHands };
}

async function verifyAdminKey(key: string | undefined): Promise<boolean> {
  const snap = await db.collection("config").doc("admin").get();
  const expected = snap.data()?.key;
  return !!key && !!expected && key === expected;
}

export const adminDeleteTable = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send({ ok: false, error: "POST only" });
      return;
    }
    try {
      const auth = req.get("authorization") || "";
      const match = auth.match(/^Bearer (.+)$/);
      const key = match?.[1];
      if (!(await verifyAdminKey(key))) {
        res.status(403).send({ ok: false, error: "Forbidden" });
        return;
      }
      const tableId = req.body?.tableId;
      if (!tableId) {
        res.status(400).send({ ok: false, error: "Missing tableId" });
        return;
      }
      const { deletedSeats, deletedHands } = await deleteTable(tableId);
      res.status(200).send({ ok: true, deletedSeats, deletedHands });
    } catch (err: any) {
      res.status(500).send({ ok: false, error: err?.message || String(err) });
    }
  }
);

export const adminDeleteAllTables = onRequest(
  { region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send({ ok: false, error: "POST only" });
      return;
    }
    try {
      const auth = req.get("authorization") || "";
      const match = auth.match(/^Bearer (.+)$/);
      const key = match?.[1];
      if (!(await verifyAdminKey(key))) {
        res.status(403).send({ ok: false, error: "Forbidden" });
        return;
      }
      const snap = await db.collection("tables").get();
      let seatsDeletedTotal = 0;
      let handsDeletedTotal = 0;
      for (const doc of snap.docs) {
        const { deletedSeats, deletedHands } = await deleteTable(doc.id);
        seatsDeletedTotal += deletedSeats;
        handsDeletedTotal += deletedHands;
      }
      res.status(200).send({
        ok: true,
        tablesDeleted: snap.size,
        seatsDeletedTotal,
        handsDeletedTotal,
      });
    } catch (err: any) {
      res.status(500).send({ ok: false, error: err?.message || String(err) });
    }
  }
);

// Trigger: hand created -> compute positions and post blinds
export const onHandCreated = onDocumentCreated(
  { region: "us-central1", document: "tables/{tableId}/hands/{handId}" },
  async (event) => {
    const tableId = event.params.tableId;
    const handId = event.params.handId;
    const tableRef = db.collection("tables").doc(tableId);
    const handRef = tableRef.collection("hands").doc(handId);

    await db.runTransaction(async (tx) => {
      const [tableSnap, handSnap] = await Promise.all([
        tx.get(tableRef),
        tx.get(handRef),
      ]);
      if (!tableSnap.exists || !handSnap.exists) return;
      const table = tableSnap.data() as any;
      const hand = handSnap.data() as any;

      const seats = await getActiveSeats(tx, tableRef);
      if (seats.length < 2) return;

      const dealerSeat = seats.find((s) => s.playerId === hand.dealerId);
      if (!dealerSeat) return;
      const sbSeat = seats[(dealerSeat.seatNum + 1) % seats.length];
      const bbSeat = seats[(dealerSeat.seatNum + 2) % seats.length];

      const sbAmount = Math.min(sbSeat.chipStackCents, table.smallBlindCents);
      const bbAmount = Math.min(bbSeat.chipStackCents, table.bigBlindCents);

      tx.update(tableRef.collection("seats").doc(sbSeat.playerId), {
        chipStackCents: sbSeat.chipStackCents - sbAmount,
      });
      tx.update(tableRef.collection("seats").doc(bbSeat.playerId), {
        chipStackCents: bbSeat.chipStackCents - bbAmount,
      });

      const contributions: Record<string, number> = {};
      contributions[sbSeat.playerId] = sbAmount;
      contributions[bbSeat.playerId] = bbAmount;

      if (!hand.deck) {
        hand.deck = makeDeck();
        shuffleInPlace(hand.deck);
        hand.deckIndex = 0;
        hand.board = [];
      }

      const roundStartSeatNum =
        seats.length === 2
          ? dealerSeat.seatNum
          : (bbSeat.seatNum + 1) % seats.length;

      tx.update(handRef, {
        positions: {
          dealerSeatNum: dealerSeat.seatNum,
          sbSeatNum: sbSeat.seatNum,
          bbSeatNum: bbSeat.seatNum,
        },
        contributions,
        potCents: sbAmount + bbAmount,
        stage: "preflop",
        lastAggressorSeatNum: bbSeat.seatNum,
        roundStartSeatNum,
        actorSeatNum: roundStartSeatNum,
        folded: {},
        deck: hand.deck,
        deckIndex: hand.deckIndex,
        board: hand.board,
      });

      const actorPlayerId =
        seats.find((s) => s.seatNum === roundStartSeatNum)?.playerId || "";
      const toCallCents = toCallFor(contributions, actorPlayerId);
      tx.update(handRef, { toCallCents, minRaiseCents: table.bigBlindCents });
    });
  }
);

// Trigger: player action intents
export const onIntentCreated = onDocumentCreated(
  { region: "us-central1", document: "tables/{tableId}/hands/{handId}/intents/{intentId}" },
  async (event) => {
    const { tableId, handId, intentId } = event.params;
    const tableRef = db.collection("tables").doc(tableId);
    const handRef = tableRef.collection("hands").doc(handId);
    const intentRef = handRef.collection("intents").doc(intentId);

    await db.runTransaction(async (tx) => {
      const [tableSnap, handSnap, intentSnap] = await Promise.all([
        tx.get(tableRef),
        tx.get(handRef),
        tx.get(intentRef),
      ]);
      if (!tableSnap.exists || !handSnap.exists || !intentSnap.exists) return;
      const hand = handSnap.data() as any;
      const intent = intentSnap.data() as any;

      if (hand.status !== "pending") {
        tx.delete(intentRef);
        return;
      }

      const seats = await getActiveSeats(tx, tableRef);
      const folded: Record<string, true> = hand.folded || {};
      const seatByNum: Record<number, SeatInfo> = {};
      const chipMap: Record<string, number> = {};
      seats.forEach((s) => {
        seatByNum[s.seatNum] = s;
        chipMap[s.playerId] = s.chipStackCents;
      });
      const seat = seats.find((s) => s.playerId === intent.playerId);
      if (!seat || seat.seatNum !== hand.actorSeatNum || folded[intent.playerId]) {
        tx.delete(intentRef);
        return;
      }
      if (chipMap[intent.playerId] <= 0) {
        tx.delete(intentRef);
        return;
      }

      let contributions: Record<string, number> = hand.contributions || {};
      let pot = hand.potCents || 0;
      let lastAggressorSeatNum = hand.lastAggressorSeatNum ?? null;
      let minRaiseCents = hand.minRaiseCents ?? hand.bbCents;

      const updateSeat = (playerId: string, newChips: number) => {
        chipMap[playerId] = newChips;
        tx.update(tableRef.collection("seats").doc(playerId), {
          chipStackCents: newChips,
        });
      };

      const toCall = toCallFor(contributions, intent.playerId);

      switch (intent.type) {
        case "fold": {
          folded[intent.playerId] = true;
          tx.update(handRef, { folded });
          break;
        }
        case "check": {
          if (toCall !== 0) {
            tx.delete(intentRef);
            return;
          }
          break;
        }
        case "call": {
          const callAmt = Math.min(toCall, chipMap[intent.playerId]);
          contributions[intent.playerId] =
            (contributions[intent.playerId] || 0) + callAmt;
          pot += callAmt;
          updateSeat(intent.playerId, chipMap[intent.playerId] - callAmt);
          tx.update(handRef, { contributions, potCents: pot });
          break;
        }
        case "raise": {
          if (
            typeof intent.amountCents !== "number" ||
            intent.amountCents < minRaiseCents
          ) {
            tx.delete(intentRef);
            return;
          }
          const highest = highestContribution(contributions);
          const playerContrib = contributions[intent.playerId] || 0;
          const target = highest + intent.amountCents;
          const needed = target - playerContrib;
          const pay = Math.min(needed, chipMap[intent.playerId]);
          contributions[intent.playerId] = playerContrib + pay;
          pot += pay;
          updateSeat(intent.playerId, chipMap[intent.playerId] - pay);
          lastAggressorSeatNum = seat.seatNum;
          minRaiseCents = intent.amountCents;
          tx.update(handRef, {
            contributions,
            potCents: pot,
            lastAggressorSeatNum,
            minRaiseCents,
          });
          break;
        }
        default:
          tx.delete(intentRef);
          return;
      }

      const remaining = seats.filter(
        (s) => !folded[s.playerId] && (chipMap[s.playerId] ?? 0) > 0
      );
      if (remaining.length <= 1) {
        const winner = remaining[0];
        if (winner) await settlePotToWinnerTx(tx, tableRef, handRef, winner.playerId);
        tx.update(handRef, { status: "ended" });
        tx.update(tableRef, { currentHandId: null });
        tx.delete(intentRef);
        return;
      }

      const nextSeatNum = nextSeat(seats, seat.seatNum, folded, chipMap);
      const nextSeatInfo = seatByNum[nextSeatNum];
      const toCallNext = toCallFor(contributions, nextSeatInfo.playerId);
      const roundClosed =
        (lastAggressorSeatNum == null && nextSeatNum === hand.roundStartSeatNum) ||
        (lastAggressorSeatNum != null &&
          nextSeatNum === lastAggressorSeatNum &&
          toCallNext === 0);

      if (roundClosed) {
        switch (hand.stage) {
          case "preflop": {
            const cards = draw(hand, 3);
            const board = (hand.board || []).concat(cards);
            const roundStartSeatNum = firstPostflopActor(
              hand.positions.dealerSeatNum,
              seats,
              folded,
              chipMap
            );
            contributions = {};
            tx.update(handRef, {
              board,
              deckIndex: hand.deckIndex,
              stage: "flop",
              lastAggressorSeatNum: null,
              roundStartSeatNum,
              actorSeatNum: roundStartSeatNum,
              toCallCents: 0,
              minRaiseCents: hand.bbCents,
              contributions,
            });
            break;
          }
          case "flop": {
            const cards = draw(hand, 1);
            const board = (hand.board || []).concat(cards);
            const roundStartSeatNum = firstPostflopActor(
              hand.positions.dealerSeatNum,
              seats,
              folded,
              chipMap
            );
            contributions = {};
            tx.update(handRef, {
              board,
              deckIndex: hand.deckIndex,
              stage: "turn",
              lastAggressorSeatNum: null,
              roundStartSeatNum,
              actorSeatNum: roundStartSeatNum,
              toCallCents: 0,
              minRaiseCents: hand.bbCents,
              contributions,
            });
            break;
          }
          case "turn": {
            const cards = draw(hand, 1);
            const board = (hand.board || []).concat(cards);
            const roundStartSeatNum = firstPostflopActor(
              hand.positions.dealerSeatNum,
              seats,
              folded,
              chipMap
            );
            contributions = {};
            tx.update(handRef, {
              board,
              deckIndex: hand.deckIndex,
              stage: "river",
              lastAggressorSeatNum: null,
              roundStartSeatNum,
              actorSeatNum: roundStartSeatNum,
              toCallCents: 0,
              minRaiseCents: hand.bbCents,
              contributions,
            });
            break;
          }
          case "river": {
            const updates: any = { status: "ended" };
            if (remaining.length > 1) updates.showdownPending = true;
            tx.update(handRef, updates);
            tx.update(tableRef, { currentHandId: null });
            break;
          }
        }
      } else {
        tx.update(handRef, {
          actorSeatNum: nextSeatNum,
          toCallCents: toCallNext,
          lastAggressorSeatNum,
          minRaiseCents,
        });
      }

      tx.delete(intentRef);
    });
  }
);

// Trigger: hand status changed -> rotate dealer and maybe start next hand
export const onHandEnded = onDocumentUpdated(
  { region: "us-central1", document: "tables/{tableId}/hands/{handId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === "ended" || after.status !== "ended") return;

    const tableId = event.params.tableId;
    const tableRef = db.collection("tables").doc(tableId);

    await db.runTransaction(async (tx) => {
      const tableSnap = await tx.get(tableRef);
      if (!tableSnap.exists) return;
      const table = tableSnap.data() as any;

      const seats = await getActiveSeats(tx, tableRef);
      const nextDealerId = rotateDealer(seats, after.dealerId);
      const nextDealerName = seats.find((s) => s.playerId === nextDealerId)?.playerName || "";
      let updates: any = {
        currentHandId: null,
        nextDealerId,
        nextDealerName,
      };

      if (seats.length >= 2 && table.nextVariantId) {
        const dealerSeat = seats.find((s) => s.playerId === nextDealerId);
        const handId = await createHandTx(tx, tableRef, {
          variant: table.nextVariantId,
          status: "pending",
          dealerId: nextDealerId,
          dealerName: dealerSeat?.playerName || "",
          startedAt: FieldValue.serverTimestamp(),
          sbCents: table.smallBlindCents,
          bbCents: table.bigBlindCents,
          potCents: 0,
        });
        const afterNext = rotateDealer(seats, nextDealerId);
        const afterNextName = seats.find((s) => s.playerId === afterNext)?.playerName || "";
        updates = {
          currentHandId: handId,
          nextDealerId: afterNext,
          nextDealerName: afterNextName,
          nextVariantId: null,
        };
      }

      tx.update(tableRef, updates);
    });
  }
);

// Trigger: variant chosen by next dealer when no hand active
export const onVariantChosen = onDocumentUpdated(
  { region: "us-central1", document: "tables/{tableId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if ((before.nextVariantId ?? null) === (after.nextVariantId ?? null)) return;
    if (after.currentHandId) return;

    const tableId = event.params.tableId;
    const tableRef = db.collection("tables").doc(tableId);

    await db.runTransaction(async (tx) => {
      const tableSnap = await tx.get(tableRef);
      if (!tableSnap.exists) return;
      const table = tableSnap.data() as any;
      if (table.currentHandId) return;

      const seats = await getActiveSeats(tx, tableRef);
      if (seats.length < 2) return;

      const dealerSeat = seats.find((s) => s.playerId === table.nextDealerId);
      if (!dealerSeat) return;

      await createHandTx(tx, tableRef, {
        variant: table.nextVariantId,
        status: "pending",
        dealerId: dealerSeat.playerId,
        dealerName: dealerSeat.playerName,
        startedAt: FieldValue.serverTimestamp(),
        sbCents: table.smallBlindCents,
        bbCents: table.bigBlindCents,
        potCents: 0,
      });

      const nextAfter = rotateDealer(seats, dealerSeat.playerId);
      const nextAfterName = seats.find((s) => s.playerId === nextAfter)?.playerName || "";
      tx.update(tableRef, {
        nextVariantId: null,
        nextDealerId: nextAfter,
        nextDealerName: nextAfterName,
      });
    });
  }
);
