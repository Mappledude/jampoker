// Cloud Functions: auto-start hands, dealer rotation, next-dealer variant
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, DocumentReference, Transaction } from "firebase-admin/firestore";
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

function nextSeat(
  seats: SeatInfo[],
  startSeatNum: number,
  folded: Record<string, true>
): number {
  const count = seats.length;
  for (let i = 1; i <= count; i++) {
    const seat = seats[(startSeatNum + i) % count];
    if (!seat) continue;
    if (folded[seat.playerId]) continue;
    if (seat.chipStackCents <= 0) continue;
    return seat.seatNum;
  }
  return startSeatNum;
}

function highestContribution(contrib: Record<string, number> = {}): number {
  return Object.values(contrib).reduce((m, v) => (v > m ? v : m), 0);
}

function toCallFor(contrib: Record<string, number>, playerId: string): number {
  const highest = highestContribution(contrib);
  const cur = contrib[playerId] || 0;
  return Math.max(0, highest - cur);
}

function minRaiseFrom(hand: any, bb: number): number {
  return hand.lastAggressorSeatNum != null && typeof hand.minRaiseCents === "number"
    ? hand.minRaiseCents
    : bb;
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
        actorSeatNum:
          seats.length === 2
            ? dealerSeat.seatNum
            : (bbSeat.seatNum + 1) % seats.length,
        folded: {},
      });

      const actorSeatNum =
        seats.length === 2
          ? dealerSeat.seatNum
          : (bbSeat.seatNum + 1) % seats.length;
      const actorPlayerId = seats.find((s) => s.seatNum === actorSeatNum)?.playerId || "";
      const toCallCents = toCallFor(contributions, actorPlayerId);
      const minRaiseCents = minRaiseFrom({ lastAggressorSeatNum: bbSeat.seatNum }, table.bigBlindCents);
      tx.update(handRef, { toCallCents, minRaiseCents });
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

      if (hand.status !== "pending" || hand.stage !== "preflop") {
        tx.delete(intentRef);
        return;
      }

      const seats = await getActiveSeats(tx, tableRef);
      const folded: Record<string, true> = hand.folded || {};
      const seatByNum: Record<number, SeatInfo> = {};
      seats.forEach((s) => (seatByNum[s.seatNum] = s));
      const seat = seats.find((s) => s.playerId === intent.playerId);
      if (!seat || seat.seatNum !== hand.actorSeatNum || folded[intent.playerId]) {
        tx.delete(intentRef);
        return;
      }
      if (seat.chipStackCents <= 0) {
        tx.delete(intentRef);
        return;
      }

      const contributions: Record<string, number> = hand.contributions || {};
      const toCall = toCallFor(contributions, intent.playerId);
      let pot = hand.potCents || 0;
      let actorSeatNum = hand.actorSeatNum;
      let lastAggressorSeatNum = hand.lastAggressorSeatNum;
      let minRaiseCents = hand.minRaiseCents;

      const updateSeat = (playerId: string, newChips: number) => {
        tx.update(tableRef.collection("seats").doc(playerId), {
          chipStackCents: newChips,
        });
      };

      const next = () => {
        const ns = nextSeat(seats, actorSeatNum, folded);
        const nextSeatInfo = seatByNum[ns];
        if (
          nextSeatInfo &&
          ns === lastAggressorSeatNum &&
          toCallFor(contributions, nextSeatInfo.playerId) === 0
        ) {
          tx.update(handRef, { status: "ended" });
          tx.update(tableRef, { currentHandId: null });
        } else if (nextSeatInfo) {
          const tc = toCallFor(contributions, nextSeatInfo.playerId);
          tx.update(handRef, { actorSeatNum: ns, toCallCents: tc });
        }
      };

      switch (intent.type) {
        case "fold": {
          folded[intent.playerId] = true;
          tx.update(handRef, { folded });
          const remaining = seats.filter(
            (s) => !folded[s.playerId] && s.chipStackCents > 0
          );
          if (remaining.length <= 1) {
            tx.update(handRef, { status: "ended" });
            tx.update(tableRef, { currentHandId: null });
            tx.delete(intentRef);
            return;
          }
          next();
          break;
        }
        case "check": {
          if (toCall !== 0) {
            tx.delete(intentRef);
            return;
          }
          next();
          break;
        }
        case "call": {
          if (toCall === 0) {
            next();
            break;
          }
          const callAmt = Math.min(toCall, seat.chipStackCents);
          contributions[intent.playerId] =
            (contributions[intent.playerId] || 0) + callAmt;
          pot += callAmt;
          seat.chipStackCents -= callAmt;
          updateSeat(intent.playerId, seat.chipStackCents);
          tx.update(handRef, { contributions, potCents: pot });
          actorSeatNum = seat.seatNum;
          next();
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
          const pay = Math.min(needed, seat.chipStackCents);
          contributions[intent.playerId] = playerContrib + pay;
          pot += pay;
          seat.chipStackCents -= pay;
          updateSeat(intent.playerId, seat.chipStackCents);
          lastAggressorSeatNum = seat.seatNum;
          minRaiseCents = intent.amountCents;
          tx.update(handRef, {
            contributions,
            potCents: pot,
            lastAggressorSeatNum,
            minRaiseCents,
          });

          const remaining = seats.filter(
            (s) => !folded[s.playerId] && s.chipStackCents > 0
          );
          if (remaining.length <= 1) {
            tx.update(handRef, { status: "ended" });
            tx.update(tableRef, { currentHandId: null });
            tx.delete(intentRef);
            return;
          }
          next();
          break;
        }
        default:
          tx.delete(intentRef);
          return;
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
