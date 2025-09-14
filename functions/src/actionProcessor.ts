import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const db = getFirestore();

interface SeatData {
  seat: number;
  stackCents: number;
}

function orderedSeats(seats: SeatData[]): number[] {
  return seats
    .map((s) => s.seat)
    .sort((a, b) => a - b);
}

function nextActiveLeft(
  seats: SeatData[],
  from: number,
  folded: Set<number>
): number | null {
  const order = orderedSeats(seats);
  const start = order.indexOf(from);
  if (start === -1) return null;
  for (let i = 1; i <= order.length; i++) {
    const seatNum = order[(start + i) % order.length];
    const data = seats.find((s) => s.seat === seatNum);
    if (!data) continue;
    if (folded.has(seatNum)) continue;
    if (data.stackCents <= 0) continue;
    return seatNum;
  }
  return null;
}

function firstActiveLeftOfDealer(
  seats: SeatData[],
  dealer: number,
  folded: Set<number>
): number | null {
  const order = orderedSeats(seats);
  const start = order.indexOf(dealer);
  if (start === -1) return null;
  for (let i = 1; i <= order.length; i++) {
    const seatNum = order[(start + i) % order.length];
    const data = seats.find((s) => s.seat === seatNum);
    if (!data) continue;
    if (folded.has(seatNum)) continue;
    if (data.stackCents <= 0) continue;
    return seatNum;
  }
  return null;
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

function advanceStreet(
  hand: any,
  seats: SeatData[],
  folded: Set<number>
) {
  const street = nextStreet(hand.street);
  const toAct = firstActiveLeftOfDealer(seats, hand.dealerSeat, folded);
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
    const seatRef = tableRef.collection("seats").doc(String(action.seat));

    try {
      await db.runTransaction(async (tx) => {
        const [handSnap, seatSnap, seatsSnap] = await Promise.all([
          tx.get(handRef),
          tx.get(seatRef),
          tx.get(tableRef.collection("seats")),
        ]);
        if (!handSnap.exists || !seatSnap.exists) return;
        const hand = handSnap.data() as any;
        const seat = seatSnap.data() as any;
        const seats: SeatData[] = seatsSnap.docs.map((d) => ({
          seat: d.data().seatIndex ?? parseInt(d.id, 10),
          stackCents: d.data().stackCents ?? 0,
        }));

        const foldedSet = new Set<number>(hand.folded ?? []);
        if (action.seat !== hand.toActSeat) return;
        if (foldedSet.has(action.seat)) return;

        const commits = hand.commits || {};
        const playerCommit = commits?.[action.seat] ?? commits?.[String(action.seat)] ?? 0;
        const betToMatch = hand.betToMatchCents || 0;

        switch (action.type) {
          case "check": {
            if (betToMatch !== playerCommit) return;
            if (everyoneMatched(commits, betToMatch, seats, foldedSet)) {
              const adv = advanceStreet(hand, seats, foldedSet);
              tx.update(handRef, adv);
            } else {
              const next = nextActiveLeft(seats, action.seat, foldedSet);
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
            const commitPath = `commits.${action.seat}`;
            if (everyoneMatched({ ...commits, [action.seat]: newCommit }, betToMatch, seats, foldedSet)) {
              const adv = advanceStreet(hand, seats, foldedSet);
              tx.update(handRef, { ...adv, [commitPath]: newCommit });
            } else {
              const next = nextActiveLeft(seats, action.seat, foldedSet);
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
      await event.data?.ref.update({ status: "applied" });
    } catch (err: any) {
      await event.data?.ref.update({
        status: "error",
        error: err?.message || String(err),
      });
    }
  }
);

