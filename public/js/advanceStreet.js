import { app } from "/firebase-init.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { awaitAuthReady } from "/auth.js";
import { logEvent } from "/js/debug.js";

const functions = getFunctions(app);
const advanceStreetCallable = httpsCallable(functions, "forceAdvanceStreet");

let activeTableId = null;
let listenerAttached = false;
let toastContainer = null;

const TOAST_DURATION = 4000;

function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
  toastContainer = document.createElement("div");
  toastContainer.className = "toast-container";
  document.body.appendChild(toastContainer);
  return toastContainer;
}

function showToast(message, variant = "info", options = {}) {
  const { duration = TOAST_DURATION } = options;
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `toast toast--${variant}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add("toast--visible");
  });

  let dismissed = false;
  let timerId = null;

  const remove = () => {
    if (dismissed) return;
    dismissed = true;
    if (timerId) clearTimeout(timerId);
    toast.classList.remove("toast--visible");
    setTimeout(() => {
      toast.remove();
      if (!container.childElementCount) {
        container.remove();
        toastContainer = null;
      }
    }, 220);
  };

  if (duration > 0) {
    timerId = setTimeout(remove, duration);
  }

  toast.addEventListener("click", remove);

  return remove;
}

async function handleAdvanceClick(button) {
  if (!activeTableId) return;
  if (button.disabled) return;

  button.disabled = true;
  const tableId = activeTableId;

  logEvent("ui.advanceStreet.start", { tableId });
  if (window.jamlog) window.jamlog.push("ui.advanceStreet.start", { tableId });
  const dismissInfo = showToast("Advancing street…", "info", { duration: 2000 });

  try {
    await awaitAuthReady();
    await advanceStreetCallable({ tableId });
    logEvent("ui.advanceStreet.ok", { tableId });
    if (window.jamlog) window.jamlog.push("ui.advanceStreet.ok", { tableId });
    dismissInfo();
    showToast("Advanced to next street", "success");
  } catch (err) {
    const message = err?.message || "Unknown error";
    logEvent("ui.advanceStreet.fail", { tableId, message });
    if (window.jamlog) window.jamlog.push("ui.advanceStreet.fail", { tableId, message });
    console.error("forceAdvanceStreet failed", err);
    dismissInfo();
    showToast(`Failed to advance street: ${message}`, "error");
  } finally {
    button.disabled = false;
  }
}

function onDocumentClick(event) {
  const target = event.target.closest("#btn-next-street");
  if (!target) return;
  event.preventDefault();
  handleAdvanceClick(target);
}

export function initAdvanceStreet({ tableId }) {
  if (!tableId) return;
  activeTableId = tableId;
  if (!listenerAttached) {
    document.addEventListener("click", onDocumentClick);
    listenerAttached = true;
  }
}
