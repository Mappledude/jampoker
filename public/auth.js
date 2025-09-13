import { app } from "/firebase-init.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

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
    console.log(`auth.anon.ready: uid=${u.uid}`);
  } else {
    signInAnonymously(auth).catch(console.error);
  }
});

export const awaitAuthReady = () => (ready ? Promise.resolve(currentUser) : readyPromise);
export const isAuthed = () => !!currentUser;
