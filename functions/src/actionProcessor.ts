import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { toSeatNumber } from "./lib/seats";

const db = getFirestore();

interface SeatData {
  seat: number;
  stackCents: number;
}

function isEligible(seat: number, seats: SeatData[], hand: any): boolean {
  const data = seats.find((s) => s.seat === seat);
  const occupied = !!data;
  const folded = new Set((hand.folded ?? []).map((n: any) => Number(n)));
  const allIn = new Set((hand.allIn ?? []).map((n: any) => Number(n)));
  return (
    occupied &&
    !folded.has(seat) &&
    !allIn.has(seat) &&
    (data?.stackCents ?? 0) > 0
  );
}

function nextEligible(seat: number, seats: SeatData[], hand: any): number {
  const order = seats.map((s) => s.seat).sort((a, b) => a - b);
  const start = order.indexOf(seat);
  for (let i = 1; i <= order.length; i++) {
    const seatNum = order[(start + i) % order.length];
    if (isEligible(seatNum, seats, hand)) return seatNum;
  }
  return seat;
}

function everyoneMatched(
  commits: Record<string, number>,
  betToMatch: number,
  seats: SeatData[],
  folded: Set<number>
): boolean {
  for (const s of seats) {
    if (folded.has(s.seat)) continue;
    const c = commits?.[s.seat] ?? commits?.[String(s.seat)] ?? 0;
    if (c !== betToMatch) return false;
  }
  return true;
}

function nextStreet(street: string): string {
  switch (street) {
    case "preflop":
      return "flop";
    case "flop":
      return "turn";
    case "turn":
      return "river";
    default:
      return "showdown";
  }
}

function advanceStreet(hand: any, seats: SeatData[]) {
  const street = nextStreet(hand.street);
  const toAct = nextEligible(hand.dealerSeat, seats, hand);
  return {
    street,
    betToMatchCents: 0,
    commits: {},
    lastAggressorSeat: -1,
    minRaiseToCents: 0,
    toActSeat: toAct,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export const onActionCreated = onDocumentCreated(
  {
    region: "us-central1",
    document: "tables/{tableId}/actions/{actionId}",
  },
  async (event) => {
    const { tableId } = event.params;
    const action = event.data?.data() as any;
    if (!action) return;

    const tableRef = db.collection("tables").doc(tableId);
    const handRef = tableRef.collection("handState").doc("current");
    const actorSeat = toSeatNumber(action.seat);
    const seatRef = tableRef.collection("seats").doc(String(actorSeat ?? -1));
    if (actorSeat == null) {
      await event.data?.ref.update({
        status: "rejected",
        reason: "not-your-turn",
        expectedSeat: null,
        actualSeat: null,
      });
      return;
    }

    try {
      const actionRef = event.data!.ref;
      let rejected = false;
      await db.runTransaction(async (tx) => {
        const [handSnap, seatSnap, seatsSnap] = await Promise.all([
          tx.get(handRef),
          tx.get(seatRef),
          tx.get(tableRef.collection("seats")),
        ]);
        if (!handSnap.exists || !seatSnap.exists) {
          tx.update(actionRef, {
            status: "rejected",
            reason: "not-your-turn",
            expectedSeat: handSnap.exists ? (handSnap.data() as any).toActSeat : null,
            actualSeat: actorSeat,
          });
          rejected = true;
          return;
        }
          const hand = handSnap.data() as any;
          hand.toActSeat = toSeatNumber(hand?.toActSeat);
          hand.sbSeat = toSeatNumber(hand?.sbSeat);
          hand.bbSeat = toSeatNumber(hand?.bbSeat);
          hand.dealerSeat = toSeatNumber(hand?.dealerSeat);
          const seat = seatSnap.data() as any;
        const seats: SeatData[] = seatsSnap.docs.map((d) => ({
          seat: d.data().seatIndex ?? parseInt(d.id, 10),
          stackCents: d.data().stackCents ?? 0,
        }));

        if (!isEligible(hand.toActSeat, seats, hand)) {
          const fixed = nextEligible(hand.toActSeat, seats, hand);
          tx.update(handRef, { toActSeat: fixed });
          hand.toActSeat = fixed;
        }

        const foldedSet = new Set<number>((hand.folded ?? []).map((n: any) => Number(n)));
        if (
          actorSeat == null ||
          actorSeat !== hand.toActSeat ||
          foldedSet.has(actorSeat)
        ) {
          tx.update(actionRef, {
            status: "rejected",
            reason: "not-your-turn",
            expectedSeat: hand.toActSeat,
            actualSeat: actorSeat,
          });
          rejected = true;
          return;
        }

        const commits = hand.commits || {};
        const playerCommit = Number(commits[String(actorSeat)] ?? 0);
        const betToMatch = hand.betToMatchCents || 0;

        switch (action.type) {
          case "check": {
            if (betToMatch !== playerCommit) return;
            if (everyoneMatched(commits, betToMatch, seats, foldedSet)) {
              const adv = advanceStreet(hand, seats);
              tx.update(handRef, adv);
            } else {
              const next = nextEligible(actorSeat, seats, hand);
              tx.update(handRef, {
                toActSeat: next,
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
            break;
          }
          case "call": {
            const need = betToMatch - playerCommit;
            if (need <= 0) return;
            if (seat.stackCents < need) throw new Error("insufficient-stack");
            const newStack = seat.stackCents - need;
            const newCommit = playerCommit + need;
            const commitPath = `commits.${actorSeat}`;
            if (everyoneMatched({ ...commits, [actorSeat]: newCommit }, betToMatch, seats, foldedSet)) {
              const adv = advanceStreet(hand, seats);
              tx.update(handRef, { ...adv, [commitPath]: newCommit });
            } else {
              const next = nextEligible(actorSeat, seats, hand);
              tx.update(handRef, {
                [commitPath]: newCommit,
                toActSeat: next,
                updatedAt: FieldValue.serverTimestamp(),
              });
            }
            tx.update(seatRef, { stackCents: newStack });
            break;
          }
          default:
            return;
        }
      });
      if (!rejected) {
        await actionRef.update({ status: "applied" });
      }
    } catch (err: any) {
      await event.data?.ref.update({
        status: "error",
        error: err?.message || String(err),
      });
    }
  }
);

