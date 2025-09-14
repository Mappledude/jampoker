//// Common helpers + “Current Player” UI (ESM)
import { app } from "/firebase-init.js";
import {
  getFirestore, collection, query, orderBy, onSnapshot,
  doc, onSnapshot as onDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export const db = getFirestore(app);

export const dollars = (cents) =>
  `$${(cents/100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

export const parseDollarsToCents = (input) => {
  const clean = String(input).replace(/[^0-9.]/g, "");
  if (!clean) return null;
  const value = Number(clean);
  if (Number.isNaN(value)) return null;
  return Math.max(0, Math.round(value * 100));
};

export const formatCard = (code) => `[ ${code} ]`;

export const stageLabel = (hand) => {
  const s = hand?.stage;
  if (s === 'flop') return 'Flop';
  if (s === 'turn') return 'Turn';
  if (s === 'river') return 'River';
  return 'Preflop';
};

const LS_KEY_ID = "currentPlayerId";
const LS_KEY_NAME = "currentPlayerName";

export const getCurrentPlayer = () => {
  const id = localStorage.getItem(LS_KEY_ID);
  const name = localStorage.getItem(LS_KEY_NAME);
  return id ? { id, name: name || "" } : null;
};

export function renderCurrentPlayerControls(containerId) {
  const root = document.getElementById(containerId);
  if (!root) return;

  root.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">You</h2>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <label class="small">Current player
          <select id="cp-select" style="margin-left:8px;padding:8px;border-radius:10px;border:1px solid #334155;background:#0b1220;color:#e5e7eb"></select>
        </label>
        <span id="cp-wallet" class="small" style="margin-left:12px;">Wallet: —</span>
      </div>
      <div id="cp-note" class="small" style="margin-top:6px;opacity:.8;">Select who you are before joining a table.</div>
    </div>
  `;

  const select = root.querySelector("#cp-select");
  const walletEl = root.querySelector("#cp-wallet");

  // Populate players dropdown (live)
  const playersCol = collection(db, "players");
  const qPlayers = query(playersCol, orderBy("createdAt", "desc"));
  let unsubPlayerDoc = null;

  onSnapshot(qPlayers, (snap) => {
    const current = getCurrentPlayer();
    const options = [];
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const id = docSnap.id;
      const name = d.name || "(no name)";
      const selected = current && current.id === id ? "selected" : "";
      options.push(`<option value="${id}" ${selected}>${name}</option>`);
    });
    select.innerHTML = options.join("") || `<option value="">(no players yet)</option>`;

    // If nothing selected but we have players, pick first
    if (!getCurrentPlayer() && snap.size > 0) {
      const first = snap.docs[0];
      localStorage.setItem(LS_KEY_ID, first.id);
      localStorage.setItem(LS_KEY_NAME, first.data().name || "");
      select.value = first.id;
      attachWalletListener(first.id);
    } else if (getCurrentPlayer()) {
      attachWalletListener(getCurrentPlayer().id);
    }
  });

  select.addEventListener("change", () => {
    const id = select.value;
    const name = select.options[select.selectedIndex]?.text || "";
    localStorage.setItem(LS_KEY_ID, id);
    localStorage.setItem(LS_KEY_NAME, name);
    attachWalletListener(id);
  });

  function attachWalletListener(playerId) {
    if (unsubPlayerDoc) unsubPlayerDoc();
    if (!playerId) {
      walletEl.textContent = "Wallet: —";
      return;
    }
    const ref = doc(db, "players", playerId);
    unsubPlayerDoc = onDoc(ref, (snap) => {
      const d = snap.data();
      const w = typeof d?.walletCents === "number" ? dollars(d.walletCents) : "$0.00";
      walletEl.textContent = `Wallet: ${w}`;
    });
  }
}

export const isDebug = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === '1' || localStorage.getItem('debug') === '1';
};

export const setDebug = (on) => {
  localStorage.setItem('debug', on ? '1' : '0');
  const url = new URL(window.location.href);
  if (on) url.searchParams.set('debug', '1');
  else url.searchParams.delete('debug');
  window.location.href = url.toString();
};

export const debugLog = (...args) => {
  if (isDebug()) console.log(...args);
};

export const getParentTableIdFromSeat = (docSnap) => docSnap.ref.parent.parent?.id;

export function showSeatsDebug(tableId, seatDocs) {
  if (!isDebug()) return;
  let box = document.getElementById('debug-seats');
  if (!box) {
    box = document.createElement('pre');
    box.id = 'debug-seats';
    box.style.fontFamily = 'monospace';
    box.style.whiteSpace = 'pre';
    box.style.fontSize = '11px';
    document.body.prepend(box);
  }
  const paths = seatDocs.slice(0,5).map((s) => s.ref.path).join('\n');
  box.textContent = `debug.tableId=${tableId}\n${paths}`;
}

export function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.position = 'fixed';
  el.style.bottom = '20px';
  el.style.left = '50%';
  el.style.transform = 'translateX(-50%)';
  el.style.background = '#7f1d1d';
  el.style.color = 'white';
  el.style.padding = '8px 12px';
  el.style.borderRadius = '8px';
  el.style.zIndex = '9999';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}


