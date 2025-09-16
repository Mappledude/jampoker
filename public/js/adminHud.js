import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  doc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { awaitAuthReady } from "/auth.js";

const DEFAULT_MAX_ACTIONS = 5;

function toIsoString(timestamp, fallbackNumber) {
  if (timestamp && typeof timestamp.toDate === "function") {
    try {
      return timestamp.toDate().toISOString();
    } catch (err) {
      console.warn("[adminHud] failed to convert timestamp", err);
    }
  }
  if (typeof fallbackNumber === "number" && Number.isFinite(fallbackNumber)) {
    try {
      return new Date(fallbackNumber).toISOString();
    } catch (err) {
      console.warn("[adminHud] failed to convert fallback number", err);
    }
  }
  return "—";
}

function jamlogPush(jamlog, type, ctx = {}) {
  if (!jamlog || typeof jamlog.push !== "function") return;
  try {
    jamlog.push(type, ctx);
  } catch (err) {
    console.warn("[adminHud] jamlog push failed", err);
  }
}

function createButton(label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.style.padding = "4px 8px";
  btn.style.borderRadius = "8px";
  btn.style.border = "1px solid #334155";
  btn.style.background = "#1e293b";
  btn.style.color = "#e2e8f0";
  btn.style.fontSize = "12px";
  btn.style.cursor = "pointer";
  btn.style.fontWeight = "600";
  btn.style.flex = "1";
  btn.style.minWidth = "0";
  btn.style.whiteSpace = "nowrap";
  btn.style.transition = "opacity 120ms ease";
  btn.disabled = false;
  return btn;
}

function syncButtonState(btn) {
  btn.style.opacity = btn.disabled ? "0.5" : "1";
  btn.style.cursor = btn.disabled ? "not-allowed" : "pointer";
}

function createHudRoot() {
  const root = document.createElement("div");
  root.id = "admin-hud";
  root.style.position = "fixed";
  root.style.right = "16px";
  root.style.bottom = "16px";
  root.style.width = "320px";
  root.style.maxWidth = "calc(100vw - 24px)";
  root.style.maxHeight = "70vh";
  root.style.display = "none";
  root.style.flexDirection = "column";
  root.style.background = "rgba(15,23,42,0.96)";
  root.style.border = "1px solid #1e293b";
  root.style.borderRadius = "12px";
  root.style.boxShadow = "0 20px 48px rgba(15,23,42,0.45)";
  root.style.zIndex = "9999";
  root.style.color = "#e2e8f0";
  root.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  root.style.fontSize = "12px";
  root.style.lineHeight = "1.4";
  root.style.overflow = "hidden";
  root.style.backdropFilter = "blur(8px)";
  root.style.gap = "0";
  root.style.boxSizing = "border-box";
  root.setAttribute("data-admin-hud", "");
  return root;
}

export function initAdminHud(config = {}) {
  const db = getFirestore();
  const functions = getFunctions();
  const takeActionTX = httpsCallable(functions, "takeActionTX");
  const advanceStreetCallable = httpsCallable(functions, "advanceStreetTX");

  const jamlog = config.jamlog ?? (typeof window !== "undefined" ? window.jamlog : null);
  const page = config.page || "UNKNOWN";
  const maxActions = typeof config.maxActions === "number" && config.maxActions > 0 ? config.maxActions : DEFAULT_MAX_ACTIONS;
  const attachTarget = config.attach ?? document.body;

  const startWorkerFn = typeof config.startWorker === "function" ? config.startWorker : null;
  const stopWorkerFn = typeof config.stopWorker === "function" ? config.stopWorker : null;
  const getWorkerStateFn = typeof config.getWorkerState === "function" ? config.getWorkerState : null;

  const state = {
    tableId: null,
    tableName: null,
    isOwner: false,
    pendingCount: 0,
    actions: [],
    status: "",
    processing: false,
    exporting: false,
    selectedKey: null,
    dealerChoice: "holdem",
    dealerChoiceSaving: false,
    nextStreetPending: false,
    checkdownEnabled: false,
    checkdownStatus: "Off",
    handStreet: null,
  };

  const CHECKDOWN_DELAY_MS = 3000;
  let checkdownTimerId = null;
  let checkdownCallPending = false;

  const root = createHudRoot();
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.justifyContent = "space-between";
  header.style.background = "rgba(30,41,59,0.85)";
  header.style.padding = "8px 12px";
  header.style.fontWeight = "600";
  header.style.fontSize = "13px";
  header.textContent = "Admin HUD";

  const headerWrap = document.createElement("div");
  headerWrap.style.display = "flex";
  headerWrap.style.flexDirection = "column";
  headerWrap.style.gap = "2px";
  const headerTitle = document.createElement("div");
  headerTitle.textContent = "Admin HUD";
  headerTitle.style.fontWeight = "600";
  const headerSubtitle = document.createElement("div");
  headerSubtitle.style.fontWeight = "400";
  headerSubtitle.style.fontSize = "11px";
  headerSubtitle.style.opacity = "0.75";
  headerWrap.appendChild(headerTitle);
  headerWrap.appendChild(headerSubtitle);
  header.innerHTML = "";
  header.appendChild(headerWrap);

  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "10px";
  body.style.padding = "10px 12px 12px 12px";
  body.style.overflow = "auto";

  const statusEl = document.createElement("div");
  statusEl.style.minHeight = "1.2em";
  statusEl.style.fontSize = "11px";
  statusEl.style.color = "#cbd5f5";

  const workerStateEl = document.createElement("div");
  workerStateEl.style.fontSize = "11px";
  workerStateEl.style.opacity = "0.85";

  const pendingEl = document.createElement("div");
  pendingEl.style.fontWeight = "600";
  pendingEl.style.fontSize = "12px";

  const dealerRow = document.createElement("div");
  dealerRow.style.display = "flex";
  dealerRow.style.alignItems = "center";
  dealerRow.style.justifyContent = "space-between";
  dealerRow.style.gap = "8px";

  const dealerLabel = document.createElement("label");
  dealerLabel.textContent = "Dealer’s choice";
  dealerLabel.style.display = "flex";
  dealerLabel.style.alignItems = "center";
  dealerLabel.style.gap = "6px";
  dealerLabel.style.fontSize = "11px";

  const dealerSelect = document.createElement("select");
  dealerSelect.style.padding = "4px 8px";
  dealerSelect.style.borderRadius = "8px";
  dealerSelect.style.border = "1px solid #334155";
  dealerSelect.style.background = "#0b1220";
  dealerSelect.style.color = "#e2e8f0";
  dealerSelect.style.fontSize = "12px";
  dealerSelect.style.fontWeight = "600";
  dealerSelect.style.minWidth = "120px";
  dealerSelect.appendChild(new Option("Hold'em", "holdem"));
  dealerSelect.appendChild(new Option("Omaha", "omaha"));
  dealerLabel.appendChild(dealerSelect);
  dealerRow.appendChild(dealerLabel);

  const streetRow = document.createElement("div");
  streetRow.style.display = "flex";
  streetRow.style.alignItems = "center";
  streetRow.style.gap = "10px";

  const nextStreetBtn = createButton("Next Street");
  nextStreetBtn.style.background = "#fbbf24";
  nextStreetBtn.style.color = "#0f172a";
  nextStreetBtn.style.flex = "1";

  const checkdownLabel = document.createElement("label");
  checkdownLabel.style.display = "flex";
  checkdownLabel.style.alignItems = "center";
  checkdownLabel.style.gap = "6px";
  checkdownLabel.style.fontSize = "11px";

  const checkdownToggle = document.createElement("input");
  checkdownToggle.type = "checkbox";
  checkdownToggle.style.margin = "0";

  const checkdownText = document.createElement("span");
  checkdownText.textContent = "Checkdown Mode";

  checkdownLabel.appendChild(checkdownToggle);
  checkdownLabel.appendChild(checkdownText);

  const checkdownStatusEl = document.createElement("span");
  checkdownStatusEl.style.fontSize = "11px";
  checkdownStatusEl.style.opacity = "0.75";

  streetRow.appendChild(nextStreetBtn);
  streetRow.appendChild(checkdownLabel);
  streetRow.appendChild(checkdownStatusEl);

  const buttonRow = document.createElement("div");
  buttonRow.style.display = "grid";
  buttonRow.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
  buttonRow.style.gap = "6px";

  const startBtn = createButton("Start Worker");
  startBtn.style.background = "#0ea5e9";
  startBtn.style.color = "white";
  syncButtonState(startBtn);
  const stopBtn = createButton("Stop Worker");
  stopBtn.style.background = "#7f1d1d";
  stopBtn.style.color = "white";
  syncButtonState(stopBtn);
  const processBtn = createButton("Process Next");
  processBtn.style.gridColumn = "1 / -1";
  processBtn.style.background = "#22c55e";
  processBtn.style.color = "#052e13";
  syncButtonState(processBtn);
  const exportBtn = createButton("Export Debug");
  exportBtn.style.gridColumn = "1 / -1";
  exportBtn.style.background = "#3b82f6";
  exportBtn.style.color = "white";
  syncButtonState(exportBtn);

  buttonRow.appendChild(startBtn);
  buttonRow.appendChild(stopBtn);
  buttonRow.appendChild(processBtn);
  buttonRow.appendChild(exportBtn);

  const exportOutput = document.createElement("textarea");
  exportOutput.readOnly = true;
  exportOutput.style.width = "100%";
  exportOutput.style.minHeight = "80px";
  exportOutput.style.maxHeight = "180px";
  exportOutput.style.background = "rgba(2,6,23,0.8)";
  exportOutput.style.color = "#e2e8f0";
  exportOutput.style.border = "1px solid #1e293b";
  exportOutput.style.borderRadius = "8px";
  exportOutput.style.padding = "8px";
  exportOutput.style.fontFamily = "monospace";
  exportOutput.style.fontSize = "11px";
  exportOutput.style.lineHeight = "1.4";
  exportOutput.style.resize = "vertical";
  exportOutput.style.boxSizing = "border-box";
  exportOutput.placeholder = "Export output will appear here.";

  const tableWrapper = document.createElement("div");
  tableWrapper.style.border = "1px solid #1e293b";
  tableWrapper.style.borderRadius = "8px";
  tableWrapper.style.overflow = "hidden";
  tableWrapper.style.background = "rgba(15,23,42,0.6)";

  const actionsTable = document.createElement("table");
  actionsTable.style.width = "100%";
  actionsTable.style.borderCollapse = "collapse";
  actionsTable.style.fontSize = "11px";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = ["ID", "Seat", "Type", "Created", "Applied", "Invalid"];
  headers.forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    th.style.textAlign = "left";
    th.style.padding = "6px";
    th.style.background = "rgba(30,41,59,0.85)";
    th.style.fontWeight = "600";
    th.style.borderBottom = "1px solid #1e293b";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement("tbody");

  actionsTable.appendChild(thead);
  actionsTable.appendChild(tbody);
  tableWrapper.appendChild(actionsTable);

  body.appendChild(statusEl);
  body.appendChild(workerStateEl);
  body.appendChild(pendingEl);
  body.appendChild(dealerRow);
  body.appendChild(streetRow);
  body.appendChild(buttonRow);
  body.appendChild(exportOutput);
  body.appendChild(tableWrapper);

  root.appendChild(header);
  root.appendChild(body);

  attachTarget.appendChild(root);

  const listeners = { pending: null, recent: null, hand: null };

  function cleanupListeners() {
    if (listeners.pending) {
      listeners.pending();
      listeners.pending = null;
    }
    if (listeners.recent) {
      listeners.recent();
      listeners.recent = null;
    }
    if (listeners.hand) {
      listeners.hand();
      listeners.hand = null;
    }
    if (checkdownTimerId) {
      clearTimeout(checkdownTimerId);
      checkdownTimerId = null;
    }
    checkdownCallPending = false;
    state.handStreet = null;
    updateCheckdownStatus();
  }

  const normalizeVariant = (value) => (value === "omaha" ? "omaha" : "holdem");

  function detachHandListener() {
    if (listeners.hand) {
      listeners.hand();
      listeners.hand = null;
    }
  }

  function attachHandListener() {
    if (listeners.hand || !state.tableId) return;
    const handDoc = doc(db, `tables/${state.tableId}/handState/current`);
    listeners.hand = onSnapshot(
      handDoc,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        state.handStreet = typeof data?.street === "string" ? data.street : null;
        evaluateCheckdown();
      },
      (err) => {
        console.error("[adminHud] hand snapshot error", err);
        state.handStreet = null;
        evaluateCheckdown();
      }
    );
  }

  function cancelCheckdownTimer() {
    if (checkdownTimerId) {
      clearTimeout(checkdownTimerId);
      checkdownTimerId = null;
    }
  }

  function computeCheckdownStatus() {
    if (!state.checkdownEnabled) return "Off";
    if (!state.tableId) return "Select a table";
    if (!state.handStreet) return "Waiting for hand";
    if (state.handStreet === "showdown") return "At showdown";
    if (state.pendingCount > 0) {
      const count = state.pendingCount;
      return `Waiting for ${count} action${count === 1 ? "" : "s"}`;
    }
    if (state.nextStreetPending || checkdownCallPending) return "Advancing…";
    if (checkdownTimerId) return "Advancing shortly";
    return "Ready";
  }

  function updateCheckdownStatus() {
    state.checkdownStatus = computeCheckdownStatus();
  }

  function shouldAutoAdvance() {
    if (!state.checkdownEnabled || !state.tableId) return false;
    if (!state.handStreet || state.handStreet === "showdown") return false;
    if (state.nextStreetPending || checkdownCallPending) return false;
    return state.pendingCount === 0;
  }

  function scheduleCheckdown() {
    if (checkdownTimerId || checkdownCallPending) return;
    checkdownTimerId = setTimeout(() => {
      checkdownTimerId = null;
      if (!shouldAutoAdvance()) {
        updateCheckdownStatus();
        render();
        return;
      }
      checkdownCallPending = true;
      updateCheckdownStatus();
      jamlogPush(jamlog, "hud.checkdown.autoAdvance.call", { tableId: state.tableId, page });
      advanceStreet("checkdown");
    }, CHECKDOWN_DELAY_MS);
    updateCheckdownStatus();
    render();
  }

  function evaluateCheckdown() {
    if (!state.checkdownEnabled || !state.tableId) {
      cancelCheckdownTimer();
      checkdownCallPending = false;
      updateCheckdownStatus();
      render();
      return;
    }
    attachHandListener();
    if (!state.handStreet || state.handStreet === "showdown") {
      cancelCheckdownTimer();
      checkdownCallPending = false;
      updateCheckdownStatus();
      render();
      return;
    }
    if (state.nextStreetPending || checkdownCallPending) {
      updateCheckdownStatus();
      render();
      return;
    }
    if (state.pendingCount === 0) {
      scheduleCheckdown();
    } else {
      cancelCheckdownTimer();
      updateCheckdownStatus();
      render();
    }
  }

  async function advanceStreet(reason) {
    if (!state.tableId || !state.isOwner) return;
    if (state.nextStreetPending) return;
    state.nextStreetPending = true;
    if (reason === "manual") {
      cancelCheckdownTimer();
      checkdownCallPending = false;
    }
    updateCheckdownStatus();
    render();

    const tableId = state.tableId;
    try {
      if (reason === "manual") {
        setStatus("Advancing street…");
      } else {
        setStatus("Checkdown advancing…");
      }
      await awaitAuthReady();
      await advanceStreetCallable({ tableId });
      if (reason === "manual") {
        jamlogPush(jamlog, "hud.nextStreet.success", { tableId, page });
      } else {
        jamlogPush(jamlog, "hud.checkdown.autoAdvance.ok", { tableId, page });
      }
      setStatus("Advanced to next street.");
    } catch (err) {
      const message = err?.message || String(err);
      setStatus(`Advance failed: ${message}`);
      if (reason === "manual") {
        jamlogPush(jamlog, "hud.nextStreet.fail", { tableId, page, message });
      } else {
        jamlogPush(jamlog, "hud.checkdown.autoAdvance.fail", { tableId, page, message });
      }
    } finally {
      state.nextStreetPending = false;
      if (reason === "checkdown") {
        checkdownCallPending = false;
      }
      updateCheckdownStatus();
      render();
      evaluateCheckdown();
    }
  }

  function setStatus(message) {
    state.status = message || "";
    statusEl.textContent = state.status;
  }

  function isWorkerRunning() {
    if (!state.tableId) return false;
    if (getWorkerStateFn) {
      try {
        return !!getWorkerStateFn(state.tableId);
      } catch (err) {
        console.warn("[adminHud] getWorkerState failed", err);
      }
    }
    return false;
  }

  function renderActions() {
    tbody.innerHTML = "";
    if (!state.tableId || !state.actions.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = state.tableId ? "No actions." : "Select a table.";
      td.style.padding = "10px";
      td.style.textAlign = "center";
      td.style.opacity = "0.7";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    state.actions.forEach((action) => {
      const tr = document.createElement("tr");
      const isInvalid = !!action.invalid;
      const isPending = !action.applied;
      tr.style.background = isInvalid
        ? "rgba(127,29,29,0.35)"
        : isPending
          ? "rgba(14,165,233,0.2)"
          : "transparent";
      tr.style.borderBottom = "1px solid rgba(30,41,59,0.7)";

      const values = [
        action.id,
        action.seat,
        action.type,
        action.createdAtISO,
        action.applied ? "yes" : "no",
        action.invalid ? "yes" : "no",
      ];
      values.forEach((value, idx) => {
        const td = document.createElement("td");
        td.textContent = value == null ? "—" : String(value);
        td.style.padding = "6px";
        td.style.verticalAlign = "top";
        if (idx === 0) {
          td.style.fontFamily = "monospace";
          td.style.fontSize = "10px";
        }
        if (idx === 3) {
          td.style.fontSize = "10px";
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function render() {
    if (!state.isOwner || !state.tableId) {
      root.style.display = "none";
    } else {
      root.style.display = "flex";
    }
    const name = state.tableName ? `${state.tableName}` : "(no name)";
    const label = state.tableId ? `${name} · ${state.tableId}` : "Select a table";
    headerTitle.textContent = "Admin HUD";
    headerSubtitle.textContent = label;
    pendingEl.textContent = state.tableId ? `Pending actions: ${state.pendingCount}` : "Pending actions: —";
    const running = isWorkerRunning();
    workerStateEl.textContent = state.tableId ? `Worker: ${running ? "running" : "stopped"}` : "Worker: —";
    dealerSelect.value = state.dealerChoice;
    dealerSelect.disabled = !state.tableId || !state.isOwner || state.dealerChoiceSaving;
    nextStreetBtn.disabled = !state.tableId || !state.isOwner || state.nextStreetPending;
    checkdownToggle.disabled = !state.tableId || !state.isOwner;
    checkdownToggle.checked = state.checkdownEnabled && !checkdownToggle.disabled;
    checkdownStatusEl.textContent = state.tableId ? state.checkdownStatus : "";
    startBtn.disabled = !state.tableId || !state.isOwner || running || state.processing;
    stopBtn.disabled = !state.tableId || !state.isOwner || !running;
    processBtn.disabled = !state.tableId || !state.isOwner || state.processing;
    exportBtn.disabled = state.exporting || !jamlog || typeof jamlog.export !== "function";
    syncButtonState(startBtn);
    syncButtonState(stopBtn);
    syncButtonState(processBtn);
    syncButtonState(exportBtn);
    syncButtonState(nextStreetBtn);
    renderActions();
  }

  function handleSnapshotActions(snap) {
    state.actions = snap.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      return {
        id: docSnap.id,
        seat: data.seat ?? "—",
        type: data.type ?? "—",
        createdAtISO: toIsoString(data.createdAt, data.clientTs),
        applied: !!data.applied,
        invalid: !!data.invalid,
      };
    });
    render();
  }

  function handleSnapshotPending(snap) {
    state.pendingCount = snap.size;
    evaluateCheckdown();
    render();
  }

  function subscribe(tableId) {
    cleanupListeners();
    if (!tableId) return;
    const actionsCol = collection(db, `tables/${tableId}/actions`);
    listeners.pending = onSnapshot(
      query(actionsCol, where("applied", "==", false)),
      (snap) => {
        handleSnapshotPending(snap);
      },
      (err) => {
        console.error("[adminHud] pending snapshot error", err);
        setStatus(`Pending load error: ${err?.message || err}`);
      }
    );
    listeners.recent = onSnapshot(
      query(actionsCol, orderBy("createdAt", "desc"), limit(maxActions)),
      (snap) => {
        handleSnapshotActions(snap);
        setStatus("Listening for actions…");
      },
      (err) => {
        console.error("[adminHud] actions snapshot error", err);
        setStatus(`Actions load error: ${err?.message || err}`);
      }
    );
  }

  async function maybeStartWorker(mode = "manual") {
    if (!state.tableId || !state.isOwner || !startWorkerFn) return;
    if (isWorkerRunning()) {
      if (mode !== "auto") {
        setStatus("Worker already running.");
      }
      render();
      return;
    }
    try {
      jamlogPush(jamlog, "worker.attach", { tableId: state.tableId, page, mode });
      const result = startWorkerFn(state.tableId);
      if (result && typeof result.then === "function") {
        setStatus("Starting worker…");
        await result;
      }
      setStatus("Worker started.");
      jamlogPush(jamlog, "hud.worker.start.ok", { tableId: state.tableId, page, mode });
    } catch (err) {
      console.error("[adminHud] start worker failed", err);
      setStatus(`Start failed: ${err?.message || err}`);
      jamlogPush(jamlog, "hud.worker.start.fail", {
        tableId: state.tableId,
        page,
        mode,
        message: err?.message || String(err),
      });
    } finally {
      render();
    }
  }

  async function maybeStopWorker() {
    if (!state.tableId || !state.isOwner || !stopWorkerFn) return;
    if (!isWorkerRunning()) {
      setStatus("Worker already stopped.");
      render();
      return;
    }
    try {
      const result = stopWorkerFn(state.tableId);
      if (result && typeof result.then === "function") {
        setStatus("Stopping worker…");
        await result;
      }
      setStatus("Worker stopped.");
      jamlogPush(jamlog, "hud.worker.stop.ok", { tableId: state.tableId, page });
    } catch (err) {
      console.error("[adminHud] stop worker failed", err);
      setStatus(`Stop failed: ${err?.message || err}`);
      jamlogPush(jamlog, "hud.worker.stop.fail", {
        tableId: state.tableId,
        page,
        message: err?.message || String(err),
      });
    } finally {
      render();
    }
  }

  async function processNext() {
    if (!state.tableId || !state.isOwner) {
      setStatus("Select a table you own to process actions.");
      return;
    }
    state.processing = true;
    render();
    setStatus("Processing next action…");
    try {
      const actionsCol = collection(db, `tables/${state.tableId}/actions`);
      const pendingQuery = query(
        actionsCol,
        where("applied", "==", false),
        orderBy("createdAt", "asc"),
        limit(1)
      );
      const snap = await getDocs(pendingQuery);
      if (snap.empty) {
        setStatus("No pending actions.");
        return;
      }
      const docSnap = snap.docs[0];
      await takeActionTX({ tableId: state.tableId, actionId: docSnap.id });
      setStatus(`Processed ${docSnap.id}`);
      jamlogPush(jamlog, "hud.process.ok", { tableId: state.tableId, actionId: docSnap.id, page });
    } catch (err) {
      console.error("[adminHud] processNext failed", err);
      setStatus(`Process failed: ${err?.message || err}`);
      jamlogPush(jamlog, "hud.process.fail", {
        tableId: state.tableId,
        page,
        message: err?.message || String(err),
        code: err?.code || null,
      });
    } finally {
      state.processing = false;
      render();
    }
  }

  async function exportDebug() {
    if (!jamlog || typeof jamlog.export !== "function") {
      setStatus("jamlog unavailable.");
      return;
    }
    state.exporting = true;
    render();
    setStatus("Exporting debug packet…");
    try {
      const packet = await jamlog.export();
      exportOutput.value = packet;
      setStatus(`Exported ${packet.length.toLocaleString()} chars.`);
      jamlogPush(jamlog, "hud.export.ok", {
        tableId: state.tableId,
        page,
        length: packet.length,
      });
    } catch (err) {
      console.error("[adminHud] export failed", err);
      setStatus(`Export failed: ${err?.message || err}`);
      jamlogPush(jamlog, "hud.export.fail", {
        tableId: state.tableId,
        page,
        message: err?.message || String(err),
      });
    } finally {
      state.exporting = false;
      render();
    }
  }

  dealerSelect.addEventListener("change", async (event) => {
    const value = normalizeVariant(event.target.value);
    if (!state.tableId || !state.isOwner) {
      dealerSelect.value = state.dealerChoice;
      return;
    }
    if (state.dealerChoiceSaving) {
      dealerSelect.value = state.dealerChoice;
      return;
    }
    const previous = state.dealerChoice;
    if (value === previous) return;
    state.dealerChoice = value;
    state.dealerChoiceSaving = true;
    render();
    try {
      await awaitAuthReady();
      await updateDoc(doc(db, `tables/${state.tableId}`), { nextVariantId: value });
      const label = value === "omaha" ? "Omaha" : "Hold'em";
      setStatus(`Dealer’s choice set to ${label}.`);
      jamlogPush(jamlog, "hud.dealerChoice.change", { tableId: state.tableId, page, variant: value });
    } catch (err) {
      console.error("[adminHud] dealer choice update failed", err);
      state.dealerChoice = previous;
      dealerSelect.value = previous;
      setStatus(`Dealer’s choice update failed: ${err?.message || err}`);
      jamlogPush(jamlog, "hud.dealerChoice.fail", { tableId: state.tableId, page, message: err?.message || String(err) });
    } finally {
      state.dealerChoiceSaving = false;
      render();
    }
  });

  nextStreetBtn.addEventListener("click", () => {
    if (!state.tableId || !state.isOwner) return;
    jamlogPush(jamlog, "hud.nextStreet.click", { tableId: state.tableId, page });
    advanceStreet("manual");
  });

  checkdownToggle.addEventListener("change", () => {
    if (!state.tableId || !state.isOwner) {
      checkdownToggle.checked = state.checkdownEnabled;
      return;
    }
    const enabled = !!checkdownToggle.checked;
    if (enabled === state.checkdownEnabled) return;
    state.checkdownEnabled = enabled;
    if (enabled) {
      jamlogPush(jamlog, "hud.checkdown.on", { tableId: state.tableId, page });
      attachHandListener();
    } else {
      jamlogPush(jamlog, "hud.checkdown.off", { tableId: state.tableId, page });
      cancelCheckdownTimer();
      checkdownCallPending = false;
      state.handStreet = null;
      detachHandListener();
    }
    updateCheckdownStatus();
    render();
    evaluateCheckdown();
  });

  startBtn.addEventListener("click", () => {
    maybeStartWorker("manual");
  });
  stopBtn.addEventListener("click", () => {
    maybeStopWorker();
  });
  processBtn.addEventListener("click", () => {
    processNext();
  });
  exportBtn.addEventListener("click", () => {
    exportDebug();
  });

  function normalizeId(value) {
    if (!value) return null;
    const str = String(value).trim();
    return str ? str : null;
  }

  function setContext({ tableId, isOwner, tableName = null, autoStart = false, dealerChoice = null } = {}) {
    const normalizedId = normalizeId(tableId);
    const normalizedName = tableName ? String(tableName) : null;
    const key = `${normalizedId || "-"}|${isOwner ? "1" : "0"}|${normalizedName || "-"}`;
    const normalizedDealerChoice = normalizeVariant(dealerChoice);
    const changed = key !== state.selectedKey;
    state.selectedKey = key;
    if (!changed) {
      if (normalizedDealerChoice !== state.dealerChoice) {
        state.dealerChoice = normalizedDealerChoice;
        render();
      }
      if (autoStart && normalizedId && isOwner) {
        maybeStartWorker("auto");
      }
      updateCheckdownStatus();
      render();
      return;
    }
    cleanupListeners();
    state.tableId = normalizedId;
    state.tableName = normalizedName;
    state.isOwner = !!isOwner && !!normalizedId;
    state.pendingCount = 0;
    state.actions = [];
    exportOutput.value = "";
    state.dealerChoice = normalizedDealerChoice;
    state.dealerChoiceSaving = false;
    state.nextStreetPending = false;
    state.checkdownEnabled = false;
    state.handStreet = null;
    state.checkdownStatus = "Off";
    checkdownToggle.checked = false;
    cancelCheckdownTimer();
    checkdownCallPending = false;
    if (!state.isOwner || !state.tableId) {
      setStatus(state.tableId ? "HUD available to table owner." : "Select a table you own.");
      render();
      return;
    }
    setStatus("Loading actions…");
    subscribe(state.tableId);
    render();
    if (autoStart) {
      maybeStartWorker("auto");
    }
    updateCheckdownStatus();
  }

  function destroy() {
    cleanupListeners();
    root.remove();
  }

  render();

  return {
    setContext,
    destroy,
    get state() {
      return { ...state };
    },
  };
}
