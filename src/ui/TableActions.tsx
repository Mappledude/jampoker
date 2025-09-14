import React, { useEffect, useRef, useState } from 'react';
import { HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';
import { computeTurnFromDoc } from '../lib/turn';
import { toSeatNumber } from '../lib/seats';
import { toast } from 'react-toastify';
import { useLatest } from './hooks/useLatest';

interface Seat {
  seat?: unknown;
  id?: string;
  uid: string;
  stackCents: number;
  [key: string]: any;
}

export interface TableActionsProps {
  uid: string;
  seats: Seat[];
  handState: HandState | null;
  onCheck: () => Promise<void>;
  onCall: (toCall: number) => Promise<void>;
  onFold: () => Promise<void>;
}

export const TableActions: React.FC<TableActionsProps> = ({
  uid,
  seats,
  handState,
  onCheck,
  onCall,
  onFold,
}) => {
  const [pending, setPending] = useState(false);
  const turn = computeTurnFromDoc(
    handState && (handState as any)?.loaded ? (handState as any) : null,
    seats as any[],
    uid
  );
  const handRef = useLatest(handState);
  const seatsRef = useLatest(seats);
  const canActRef = useRef(turn.canAct);
  const lastActionAtRef = useRef(0);

  useEffect(() => {
    canActRef.current = turn.canAct;
    telemetry('action.ui.gated', {
      canAct: turn.canAct,
      canCheck: turn.canCheck,
      canCall: turn.canCall,
      canBet: turn.canBet,
      canFold: turn.canFold,
    });
  }, [turn.canAct, turn.canCheck, turn.canCall, turn.canBet, turn.canFold]);

  useEffect(() => {
    telemetry('turn.snapshot', {
      myUid: uid,
      mySeat: turn.mySeat,
      toActSeat: toSeatNumber(handState?.toActSeat),
      seats: (seats ?? []).map((s: any, i: number) => ({
        i,
        seat: toSeatNumber((s as any)?.seat ?? i),
        uid: (s as any)?.uid,
      })),
      street: handState?.street,
      handNo: (handState as any)?.handNo,
    });
  }, [uid, turn.mySeat, handState?.toActSeat, handState?.street, (handState as any)?.handNo, seats]);

  const MIN_DELAY = 400;
  const MAX_DELAY = 600;

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), MAX_DELAY);
    const updated: any = handState && (handState as any).updatedAt;
    const ready =
      updated?.toMillis &&
      updated.toMillis() > lastActionAtRef.current &&
      Date.now() - lastActionAtRef.current >= MIN_DELAY;
    if (ready) {
      setPending(false);
      clearTimeout(timer);
    }
    return () => clearTimeout(timer);
  }, [handState?.updatedAt, pending]);

  if (!turn.ready) {
    return null;
  }

  const label = turn.canCheck
    ? 'Check'
    : `Call $${(turn.owe / 100).toFixed(2)}`;

  const handlePrimary = async () => {
    const handNow = handRef.current;
    const seatsNow = seatsRef.current as any[];
    const turnNow = computeTurnFromDoc(
      handNow && (handNow as any)?.loaded ? (handNow as any) : null,
      seatsNow,
      uid
    );
    telemetry('turn.snapshot', {
      myUid: uid,
      mySeat: turnNow.mySeat,
      toActSeat: turnNow.toActSeat,
      toMatch: turnNow.toMatch,
      myCommit: turnNow.myCommit,
      owe: turnNow.owe,
      street: (handNow as any)?.street,
      handNo: (handNow as any)?.handNo,
    });
    if (!turnNow.canAct || (!turnNow.canCheck && !turnNow.canCall)) {
      telemetry('action.guard', {
        reason: 'not-your-turn',
        myUid: uid,
        mySeat: turnNow.mySeat,
        toActSeat: turnNow.toActSeat,
        toMatch: turnNow.toMatch,
        myCommit: turnNow.myCommit,
        owe: turnNow.owe,
        street: (handNow as any)?.street,
      });
      toast.info(`It's seat ${turnNow.toActSeat}'s turn`);
      return;
    }
    setPending(true);
    lastActionAtRef.current = Date.now();
    try {
      if (turnNow.canCheck) {
        telemetry('action.check.start', { seat: turnNow.mySeat });
        await onCheck();
        telemetry('action.check.ok', { seat: turnNow.mySeat });
      } else if (turnNow.canCall) {
        telemetry('action.call.start', { seat: turnNow.mySeat, amount: turnNow.owe });
        await onCall(turnNow.owe);
        telemetry('action.call.ok', { seat: turnNow.mySeat, amount: turnNow.owe });
      }
    } catch (e: any) {
      const reason = e?.message || 'error';
      const event = turnNow.canCheck ? 'action.check.fail' : 'action.call.fail';
      telemetry(event, { seat: turnNow.mySeat, reason });
      setPending(false);
    }
  };

  const handleFold = async () => {
    const handNow = handRef.current;
    const seatsNow = seatsRef.current as any[];
    const turnNow = computeTurnFromDoc(
      handNow && (handNow as any)?.loaded ? (handNow as any) : null,
      seatsNow,
      uid
    );
    telemetry('turn.snapshot', {
      myUid: uid,
      mySeat: turnNow.mySeat,
      toActSeat: turnNow.toActSeat,
      toMatch: turnNow.toMatch,
      myCommit: turnNow.myCommit,
      owe: turnNow.owe,
      street: (handNow as any)?.street,
      handNo: (handNow as any)?.handNo,
    });
    if (!turnNow.canFold) {
      telemetry('action.guard', {
        reason: 'not-your-turn',
        myUid: uid,
        mySeat: turnNow.mySeat,
        toActSeat: turnNow.toActSeat,
        toMatch: turnNow.toMatch,
        myCommit: turnNow.myCommit,
        owe: turnNow.owe,
        street: (handNow as any)?.street,
      });
      toast.info(`It's seat ${turnNow.toActSeat}'s turn`);
      return;
    }
    setPending(true);
    lastActionAtRef.current = Date.now();
    try {
      telemetry('action.fold.start', { seat: turnNow.mySeat });
      await onFold();
      telemetry('action.fold.ok', { seat: turnNow.mySeat });
    } catch (e: any) {
      telemetry('action.fold.fail', { seat: turnNow.mySeat, reason: e?.message || 'error' });
      setPending(false);
    }
  };

  return (
    <div>
      <button
        disabled={!turn.canAct || (!turn.canCheck && !turn.canCall) || pending}
        onClick={handlePrimary}
        title={!turn.canAct ? 'Not your turn' : undefined}
      >
        {label}
      </button>
      <button
        disabled={!turn.canFold || pending}
        onClick={handleFold}
        title={!turn.canAct ? 'Not your turn' : undefined}
      >
        Fold
      </button>
      {process.env.NODE_ENV !== 'production' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            padding: '4px',
            fontSize: '12px',
          }}
        >
          Seat: {String(turn.mySeat)} | To act: {String(turn.toActSeat)} | Street: {handState?.street}
          <br />
          ToMatch: {turn.toMatch} | MyCommit: {turn.myCommit} | Owe: {turn.owe}
        </div>
      )}
    </div>
  );
};
