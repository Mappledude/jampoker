import { DocumentReference, onSnapshot } from 'firebase/firestore';

export function subscribeHand(
  ref: DocumentReference,
  cb: (data: any) => void
) {
  let lastVersion = -1;
  return onSnapshot(ref, (snap) => {
    const data = snap.data();
    const version = typeof data?.version === 'number' ? data.version : 0;
    if (version < lastVersion) return;
    lastVersion = version;
    cb(data);
  });
}
