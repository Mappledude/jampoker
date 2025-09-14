import {
  getFirestore, doc, collection, query, where, orderBy, limit,
  onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export function startActionWorker(tableId, adminUid) {
  const db = getFirestore();

  const q = query(
    collection(db, `tables/${tableId}/actions`),
    where("applied", "==", false),
    orderBy("createdAt", "asc"),
    limit(1)
  );

  return onSnapshot(q, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== "added") return;
      applyAction(ch.doc.id).catch(e => console.error("srv.action.error", e));
    });
  });

  async function applyAction(actionId) {
    const actionRef = doc(db, `tables/${tableId}/actions/${actionId}`);
    const hsRef = doc(db, `tables/${tableId}/handState/current`);

    await runTransaction(db, async (tx) => {
      const [aSnap, hsSnap] = await Promise.all([tx.get(actionRef), tx.get(hsRef)]);
      if (!aSnap.exists()) return;
      const a = aSnap.data();
      if (a.applied) return;

      const hs = hsSnap.data();
      if (!hs) throw new Error("no-handstate");
      if (a.handNo !== hs.handNo) throw new Error("stale-hand");
      if (a.seat !== hs.toActSeat) throw new Error("not-your-turn");

      const toMatch = hs.toMatch ?? 0;
      const commits = { ...(hs.commits ?? {}) };
      const cur = commits[a.seat] ?? 0;

      const bumpVersion = (hs.version ?? 0) + 1;
      const nextSeat = hs.toActSeat === 0 ? 1 : 0; // TODO: generalize ring order

      if (a.type === "call") {
        const delta = Math.max(0, toMatch - cur);
        commits[a.seat] = cur + delta;
        tx.update(hsRef, {
          commits,
          toActSeat: nextSeat,
          version: bumpVersion,
          updatedAt: serverTimestamp()
        });
      } else if (a.type === "fold") {
        tx.update(hsRef, {
          toActSeat: nextSeat,
          folded: { ...(hs.folded ?? {}), [a.seat]: true },
          version: bumpVersion,
          updatedAt: serverTimestamp()
        });
      } else if (a.type === "check") {
        tx.update(hsRef, {
          toActSeat: nextSeat,
          version: bumpVersion,
          updatedAt: serverTimestamp()
        });
      } else {
        throw new Error(`unsupported-action:${a.type}`);
      }

      tx.update(actionRef, {
        applied: true,
        appliedAt: serverTimestamp(),
        appliedBy: adminUid
      });
    });

    console.log("srv.action.applied", { actionId });
  }
}

