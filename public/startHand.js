import { app } from "/firebase-init.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { awaitAuthReady, auth } from "/auth.js";
import { logEvent } from "/js/debug.js";
import { handDocPath } from "/js/dbPaths.js";

const db = getFirestore(app);
const fns = getFunctions(app);

export async function startHand(tableId) {
  if (window.jamlog) window.jamlog.push('hand.start.click');
  try {
    await awaitAuthReady();
    const path = handDocPath(tableId);
    const uid = auth.currentUser?.uid || 'anon';
    let createdByUid = null;
    try {
      const tSnap = await getDoc(doc(db, `tables/${tableId}`));
      createdByUid = tSnap.exists() ? (tSnap.data().createdByUid || null) : null;
    } catch {}
    const isAdmin = !!(createdByUid && createdByUid === uid);
    logEvent('hand.start.ruleProbe', { tableId, path, uid, createdByUid, isAdmin, keys: [] });
    const callable = httpsCallable(fns, 'startHand');
    await callable({ tableId });
    let handNoAfter = null;
    try {
      const handSnap = await getDoc(doc(db, path));
      if (handSnap.exists()) {
        const after = handSnap.data()?.handNo;
        if (typeof after === 'number' && Number.isFinite(after)) handNoAfter = after;
      }
    } catch (err) {
      console.warn('hand.start.inspect.fail', err);
    }
    logEvent('hand.start.ok', { path, tableId, handNoAfter });
    if (window.jamlog) {
      const ctx = { path, tableId };
      if (handNoAfter !== null) ctx.handNoAfter = handNoAfter;
      window.jamlog.push('hand.start.ok', ctx);
    }
  } catch (err) {
    const code = err?.code;
    const msg = err?.message;
    const path = handDocPath(tableId);
    const uid = auth.currentUser?.uid || 'anon';
    let createdByUid = null;
    try {
      const tSnap = await getDoc(doc(db, `tables/${tableId}`));
      createdByUid = tSnap.exists() ? (tSnap.data().createdByUid || null) : null;
    } catch {}
    const isAdmin = !!(createdByUid && createdByUid === uid);
    logEvent('hand.start.fail', { code, message: msg, path, uid, createdByUid, isAdmin });
    if (window.jamlog) window.jamlog.push('hand.start.fail', { code, message: msg });
    if (code === 'failed-precondition') alert('Need 2+ players');
    else alert('Error starting hand.');
    throw err;
  }
}
