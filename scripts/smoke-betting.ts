import { initializeApp } from 'firebase/app';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from 'firebase/functions';
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
} from 'firebase/auth';

/**
 * Smoke test for heads-up betting. Expected snapshots when run against an empty emulator:
 * A → { commits: { '0': 50, '1': 25 }, potCents: 0, toActSeat: 1, street: 'preflop', betToMatchCents: 50 }
 * B → { commits: { '0': 50, '1': 50 }, potCents: 100, toActSeat: 0, street: 'preflop', betToMatchCents: 50 }
 * C → { commits: {}, potCents: 200, toActSeat: 1, street: 'flop', betToMatchCents: 0 }
 */

const firebaseConfig = {
  apiKey: 'AIzaSyA2xi-TpIZYXJP8WIeLuSojgNHmUJMe0vc',
  authDomain: 'jam-poker.firebaseapp.com',
  projectId: 'jam-poker',
  storageBucket: 'jam-poker.firebasestorage.app',
  messagingSenderId: '1026182214332',
  appId: '1:1026182214332:web:0e8122bf7da47e48a896b9',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type HandStateDoc = {
  handNo?: number;
  sbSeat?: number;
  bbSeat?: number;
  commits?: Record<string, number>;
  potCents?: number;
  toActSeat?: number | null;
  street?: string;
  betToMatchCents?: number;
};

type SeatSeed = {
  seatIndex: number;
  uid: string;
  displayName: string;
  stackCents: number;
};

function parseHostPort(spec: string | undefined, fallbackPort: number): { host: string; port: number } {
  if (!spec) return { host: '127.0.0.1', port: fallbackPort };
  try {
    if (spec.includes('://')) {
      const url = new URL(spec);
      return {
        host: url.hostname,
        port: Number(url.port) || fallbackPort,
      };
    }
  } catch {
    // ignore parse failures and fall back to colon handling
  }
  const [hostPart, portPart] = spec.split(':');
  const host = hostPart && hostPart.length > 0 ? hostPart : '127.0.0.1';
  const portNum = Number(portPart);
  return {
    host,
    port: Number.isFinite(portNum) && portNum > 0 ? portNum : fallbackPort,
  };
}

function sortCommits(commits: Record<string, number> | undefined): Record<string, number> {
  const entries = Object.entries(commits ?? {});
  entries.sort(([a], [b]) => Number(a) - Number(b));
  return Object.fromEntries(entries);
}

async function seedSeats(db: Firestore, tableId: string, seats: SeatSeed[]): Promise<void> {
  const batch = writeBatch(db);
  for (const seat of seats) {
    const seatRef = doc(db, 'tables', tableId, 'seats', String(seat.seatIndex));
    batch.set(seatRef, {
      seatIndex: seat.seatIndex,
      occupiedBy: seat.uid,
      displayName: seat.displayName,
      sittingOut: false,
      stackCents: seat.stackCents,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

async function enqueueAction(
  db: Firestore,
  tableId: string,
  seat: number,
  uid: string,
  handNo: number,
  type: 'check' | 'call' | 'bet' | 'raise' | 'fold',
  amountCents?: number,
): Promise<string> {
  const ref = doc(collection(db, `tables/${tableId}/actions`));
  const payload: Record<string, unknown> = {
    handNo,
    seat,
    type,
    createdByUid: uid,
    actorUid: uid,
    createdAt: serverTimestamp(),
    clientTs: Date.now(),
    applied: false,
  };
  if (typeof amountCents === 'number') payload.amountCents = amountCents;
  await setDoc(ref, payload);
  return ref.id;
}

async function main() {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);
  const functions = getFunctions(app, 'us-central1');

  const shouldUseEmulator =
    process.env.FUNCTIONS_EMULATOR === '1' ||
    Boolean(process.env.FIRESTORE_EMULATOR_HOST) ||
    Boolean(process.env.FUNCTIONS_EMULATOR_HOST) ||
    Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

  if (shouldUseEmulator) {
    const firestoreInfo = parseHostPort(process.env.FIRESTORE_EMULATOR_HOST, 8080);
    connectFirestoreEmulator(db, firestoreInfo.host, firestoreInfo.port);

    const functionsOrigin = process.env.FIREBASE_FUNCTIONS_EMULATOR_ORIGIN;
    const functionsInfo = functionsOrigin
      ? parseHostPort(functionsOrigin, 5001)
      : parseHostPort(process.env.FUNCTIONS_EMULATOR_HOST, 5001);
    connectFunctionsEmulator(functions, functionsInfo.host, functionsInfo.port);

    const authInfo = parseHostPort(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9099);
    connectAuthEmulator(auth, `http://${authInfo.host}:${authInfo.port}`, { disableWarnings: true });
  }

  const cred = await signInAnonymously(auth);
  const controllerUid = cred.user?.uid ?? 'smoke-controller';

  const tableRef = doc(collection(db, 'tables'));
  const tableId = tableRef.id;
  const seats: SeatSeed[] = [
    { seatIndex: 0, uid: 'player-bb', displayName: 'BB Bot', stackCents: 10000 },
    { seatIndex: 1, uid: 'player-sb', displayName: 'SB Bot', stackCents: 10000 },
  ];

  await setDoc(tableRef, {
    name: `Smoke 25/50 ${new Date().toISOString()}`,
    active: true,
    createdAt: serverTimestamp(),
    maxSeats: 9,
    activeSeatCount: seats.length,
    gameType: 'holdem',
    blinds: { sbCents: 25, bbCents: 50 },
    buyIn: { minCents: 1000, defaultCents: 2000, maxCents: 5000 },
    createdByUid: controllerUid,
    lastWriteBy: 'scripts/smoke-betting',
  });
  console.log('Created table', tableId);

  await seedSeats(db, tableId, seats);
  console.log('Seeded seats', seats.map(({ seatIndex, uid }) => ({ seatIndex, uid })));

  const startHand = httpsCallable(functions, 'startHand');
  await startHand({ tableId });
  await sleep(500);

  const handRef = doc(db, 'tables', tableId, 'handState', 'current');
  const logState = async (label: 'A' | 'B' | 'C'): Promise<HandStateDoc> => {
    const snap = await getDoc(handRef);
    if (!snap.exists()) throw new Error('hand state missing');
    const data = snap.data() as HandStateDoc;
    const summary = {
      commits: sortCommits(data.commits),
      potCents: data.potCents ?? 0,
      toActSeat: data.toActSeat ?? null,
      street: data.street ?? null,
      betToMatchCents: data.betToMatchCents ?? 0,
    };
    console.log(label, summary);
    return data;
  };

  const stateA = await logState('A');
  const handNo = stateA.handNo;
  if (typeof handNo !== 'number') throw new Error('handNo missing after startHand');

  const sbSeat = stateA.sbSeat;
  const bbSeat = stateA.bbSeat;
  if (typeof sbSeat !== 'number' || typeof bbSeat !== 'number') {
    throw new Error('missing blind seats in hand state');
  }

  const sbPlayer = seats.find((s) => s.seatIndex === sbSeat);
  const bbPlayer = seats.find((s) => s.seatIndex === bbSeat);
  if (!sbPlayer || !bbPlayer) throw new Error('blind seat not seeded');

  const takeActionTX = httpsCallable(functions, 'takeActionTX');

  const sbActionId = await enqueueAction(db, tableId, sbSeat, sbPlayer.uid, handNo, 'call');
  await takeActionTX({ tableId, actionId: sbActionId });
  await sleep(500);
  await logState('B');

  const bbActionId = await enqueueAction(db, tableId, bbSeat, bbPlayer.uid, handNo, 'check');
  await takeActionTX({ tableId, actionId: bbActionId });
  await sleep(500);
  await logState('C');

  console.log('Smoke test complete');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
