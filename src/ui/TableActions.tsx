import React, { useEffect, useRef, useState } from 'react';
import { HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';
import { computeLiveTurn } from '../lib/turn';
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
  const turn = computeLiveTurn(
    handState && (handState as any)?.loaded ? (handState as any) : null,
    seats as any[],
    uid
  );
  const myStack = turn.mySeat >= 0 ? Number((seats as any[])[turn.mySeat]?.stackCents ?? 0) : 0;
  const canAct = turn.toActSeat === turn.mySeat;
  const canCheck = canAct && turn.owe === 0;
  const canCall = canAct && turn.owe > 0 && myStack >= turn.owe;
  const canFold = canAct;
  const handRef = useLatest(handState);
  const seatsRef = useLatest(seats);
  const canActRef = useRef(canAct);
  const lastActionAtRef = useRef(0);

  useEffect(() => {
    canActRef.current = canAct;
    telemetry('action.ui.gated', {
      canAct,
      canCheck,
      canCall,
      canBet: canAct && turn.toMatch === 0 && myStack > 0,
      canFold,
    });
  }, [canAct, canCheck, canCall, canFold, turn.toMatch, myStack]);

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

  const ready = handState && turn.mySeat >= 0 && turn.toActSeat !== null;
  if (!ready) {
    return null;
  }

  const label = canCheck
    ? 'Check'
    : `Call $${(turn.owe / 100).toFixed(2)}`;
  const potLabel = `$${(turn.potCents / 100).toFixed(2)}`;

  const handlePrimary = async () => {
    const handNow = handRef.current;
    const seatsNow = seatsRef.current as any[];
    const turnNow = computeLiveTurn(
      handNow && (handNow as any)?.loaded ? (handNow as any) : null,
      seatsNow,
      uid
    );
    const stackNow =
      turnNow.mySeat >= 0 ? Number(seatsNow[turnNow.mySeat]?.stackCents ?? 0) : 0;
    const canActNow = turnNow.toActSeat === turnNow.mySeat;
    const canCheckNow = canActNow && turnNow.owe === 0;
    const canCallNow = canActNow && turnNow.owe > 0 && stackNow >= turnNow.owe;
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
    if (!canActNow || (!canCheckNow && !canCallNow)) {
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
      if (canCheckNow) {
        telemetry('action.check.start', { seat: turnNow.mySeat });
        await onCheck();
        telemetry('action.check.ok', { seat: turnNow.mySeat });
      } else if (canCallNow) {
        telemetry('action.call.start', { seat: turnNow.mySeat, amount: turnNow.owe });
        await onCall(turnNow.owe);
        telemetry('action.call.ok', { seat: turnNow.mySeat, amount: turnNow.owe });
      }
    } catch (e: any) {
      const reason = e?.message || 'error';
      const event = canCheckNow ? 'action.check.fail' : 'action.call.fail';
      telemetry(event, { seat: turnNow.mySeat, reason });
      setPending(false);
    }
  };

  const handleFold = async () => {
    const handNow = handRef.current;
    const seatsNow = seatsRef.current as any[];
    const turnNow = computeLiveTurn(
      handNow && (handNow as any)?.loaded ? (handNow as any) : null,
      seatsNow,
      uid
    );
    const stackNow =
      turnNow.mySeat >= 0 ? Number(seatsNow[turnNow.mySeat]?.stackCents ?? 0) : 0;
    const canActNow = turnNow.toActSeat === turnNow.mySeat;
    const canFoldNow = canActNow;
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
    if (!canFoldNow) {
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
      <div>Pot: {potLabel}</div>
      <button
        disabled={!canAct || (!canCheck && !canCall) || pending}
        onClick={handlePrimary}
        title={!canAct ? 'Not your turn' : undefined}
      >
        {label}
      </button>
      <button
        disabled={!canFold || pending}
        onClick={handleFold}
        title={!canAct ? 'Not your turn' : undefined}
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
