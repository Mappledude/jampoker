import { app } from "/firebase-init.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { isDebug } from "/common.js";

export const auth = getAuth(app);
let currentUser = auth.currentUser;
let ready = false;
let readyResolve;
const readyPromise = new Promise((res) => { readyResolve = res; });

onAuthStateChanged(auth, (u) => {
  if (u) {
    currentUser = u;
    ready = true;
    readyResolve(u);
    if (window.jamlog && isDebug()) {
      window.jamlog.setUid(u.uid);
      window.jamlog.push('auth.ready', { uid: u.uid });
    }
  } else {
    if (window.jamlog && isDebug()) window.jamlog.push('auth.signInAnonymously.start');
    signInAnonymously(auth)
      .then(() => {
        if (window.jamlog && isDebug()) window.jamlog.push('auth.signInAnonymously.ok');
      })
      .catch((e) => {
        if (window.jamlog && isDebug()) {
          window.jamlog.push('auth.signInAnonymously.fail', { code: e?.code, message: e?.message });
        }
        console.error(e);
      });
  }
});

export const awaitAuthReady = () => (ready ? Promise.resolve(currentUser) : readyPromise);
export const isAuthed = () => !!currentUser;
