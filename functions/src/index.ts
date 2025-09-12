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
      });
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
