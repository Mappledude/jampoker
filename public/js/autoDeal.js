import { app } from '/firebase-init.js';
import { db } from '/common.js';
import { awaitAuthReady } from '/auth.js';
import { collection, doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js';

const TEN_SECONDS = 10000;

const normalizeVariant = (value) => (value === 'omaha' ? 'omaha' : 'holdem');

const countOccupied = (snap) => {
  let count = 0;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data && typeof data.occupiedBy === 'string' && data.occupiedBy) count += 1;
  });
  return count;
};

export function initAutoDeal({
  tableId,
  initialVariant = 'holdem',
  onTick,
} = {}) {
  if (!tableId) throw new Error('tableId required for auto deal');

  const fns = getFunctions(app);
  const callable = httpsCallable(fns, 'startHandAndDeal');

  let currentVariant = normalizeVariant(initialVariant);
  let seatCount = 0;
  let handActive = false;
  let timerId = null;
  let tickerId = null;
  let targetAt = null;
  let destroyed = false;
  let unsubSeats = null;
  let unsubHand = null;

  const emitTick = (ms) => {
    if (typeof onTick === 'function') onTick(ms);
  };

  const clearTimer = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (tickerId) {
      clearInterval(tickerId);
      tickerId = null;
    }
    targetAt = null;
  };

  const cancelCountdown = (logEvent = true) => {
    if (!timerId && !tickerId) return;
    clearTimer();
    emitTick(null);
    if (logEvent && window.jamlog) window.jamlog.push('auto.deal.canceled', { tableId });
  };

  const scheduleCountdown = () => {
    if (timerId || tickerId) return;
    targetAt = Date.now() + TEN_SECONDS;
    if (window.jamlog) {
      window.jamlog.push('auto.deal.scheduled', { tableId, inMs: TEN_SECONDS, variant: currentVariant });
    }
    emitTick(TEN_SECONDS);
    timerId = setTimeout(async () => {
      clearTimer();
      emitTick(0);
      if (!(seatCount >= 2 && !handActive) || destroyed) return;
      if (window.jamlog) window.jamlog.push('auto.deal.call', { tableId, variant: currentVariant });
      try {
        await awaitAuthReady();
        await callable({ tableId, variant: currentVariant });
      } catch (err) {
        console.error('startHandAndDeal failed', err);
      }
    }, TEN_SECONDS);
    tickerId = setInterval(() => {
      if (!targetAt) return;
      const remaining = Math.max(0, targetAt - Date.now());
      emitTick(remaining);
    }, 250);
  };

  const evaluate = () => {
    if (destroyed) return;
    const eligible = seatCount >= 2 && !handActive;
    if (eligible) scheduleCountdown();
    else cancelCountdown();
  };

  unsubSeats = onSnapshot(
    collection(db, 'tables', tableId, 'seats'),
    (snap) => {
      seatCount = countOccupied(snap);
      evaluate();
    },
    (err) => {
      console.error('autoDeal seats listener error', err);
      cancelCountdown(false);
    },
  );

  unsubHand = onSnapshot(
    doc(db, 'tables', tableId, 'handState', 'current'),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const street = data && data.street;
      handActive = !!street;
      if (handActive) {
        cancelCountdown();
      } else {
        evaluate();
      }
    },
    (err) => {
      console.error('autoDeal hand listener error', err);
      cancelCountdown(false);
    },
  );

  const controller = {
    setVariant(value) {
      const normalized = normalizeVariant(value);
      if (normalized === currentVariant) return;
      currentVariant = normalized;
      if (timerId || tickerId) {
        cancelCountdown(true);
        evaluate();
      }
    },
    destroy() {
      destroyed = true;
      cancelCountdown(false);
      emitTick(null);
      if (unsubSeats) unsubSeats();
      if (unsubHand) unsubHand();
      unsubSeats = null;
      unsubHand = null;
    },
  };

  evaluate();

  return controller;
}
