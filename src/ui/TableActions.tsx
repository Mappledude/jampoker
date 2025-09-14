import React, { useEffect, useRef, useState } from 'react';
import { HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';
import { computeTurn } from '../lib/turn';
import { findMySeat, toSeatNumber } from '../lib/seats';
import { toast } from 'react-toastify';

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
  const mySeat = findMySeat(seats as any[], uid);
  const seatObj = seats.find((s) => toSeatNumber((s as any)?.seat ?? (s as any)?.id) === mySeat);
  const myStack = mySeat == null ? 0 : seatObj?.stackCents ?? 0;
  const turn = computeTurn(handState && (handState as any)?.loaded ? (handState as any) : null, mySeat, myStack);
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
      mySeat,
      toActSeat: toSeatNumber(handState?.toActSeat),
      seats: (seats ?? []).map((s: any, i: number) => ({
        i,
        seat: toSeatNumber((s as any)?.seat ?? i),
        uid: (s as any)?.uid,
      })),
      street: handState?.street,
      handNo: (handState as any)?.handNo,
    });
  }, [uid, mySeat, handState?.toActSeat, handState?.street, (handState as any)?.handNo, seats]);

  useEffect(() => {
    if (!pending) return;
    const updated: any = handState && (handState as any).updatedAt;
    if (updated?.toMillis && updated.toMillis() > lastActionAtRef.current) {
      setPending(false);
    }
  }, [handState?.updatedAt, pending]);

  if (!turn.ready) {
    return null;
  }

  const label = turn.canCheck
    ? 'Check'
    : `Call $${(turn.owe / 100).toFixed(2)}`;

  const logGuard = () => {
    telemetry('action.guard', {
      reason: 'not-your-turn',
      myUid: uid,
      mySeat,
      toActSeat: turn.toActSeat,
      toMatch: turn.toMatch,
      myCommit: turn.myCommit,
      owe: turn.owe,
      street: handState?.street,
    });
    toast.info(`It's seat ${turn.toActSeat}'s turn`);
  };

  const handlePrimary = async () => {
    if (!turn.canAct || (!turn.canCheck && !turn.canCall)) {
      logGuard();
      return;
    }
    setPending(true);
    lastActionAtRef.current = Date.now();
    try {
      if (turn.canCheck) {
        telemetry('action.check.start', { seat: mySeat });
        await onCheck();
        telemetry('action.check.ok', { seat: mySeat });
      } else if (turn.canCall) {
        telemetry('action.call.start', { seat: mySeat, amount: turn.owe });
        await onCall(turn.owe);
        telemetry('action.call.ok', { seat: mySeat, amount: turn.owe });
      }
    } catch (e: any) {
      const reason = e?.message || 'error';
      const event = turn.canCheck ? 'action.check.fail' : 'action.call.fail';
      telemetry(event, { seat: mySeat, reason });
      setPending(false);
    }
  };

  const handleFold = async () => {
    if (!turn.canFold) {
      logGuard();
      return;
    }
    setPending(true);
    lastActionAtRef.current = Date.now();
    try {
      telemetry('action.fold.start', { seat: mySeat });
      await onFold();
      telemetry('action.fold.ok', { seat: mySeat });
    } catch (e: any) {
      telemetry('action.fold.fail', { seat: mySeat, reason: e?.message || 'error' });
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
          Seat: {String(mySeat)} | To act: {String(turn.toActSeat)} | Street: {handState?.street}
          <br />
          ToMatch: {turn.toMatch} | MyCommit: {turn.myCommit} | Owe: {turn.owe}
        </div>
      )}
    </div>
  );
};
