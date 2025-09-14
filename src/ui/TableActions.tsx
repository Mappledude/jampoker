import React, { useEffect, useRef, useState } from 'react';
import { HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';
import {
  deriveActionAvailability,
  findMySeatIndex,
  Seat,
} from '../table/actionUtils';

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
  const mySeat = findMySeatIndex(seats, uid);
  const myStack = mySeat == null ? 0 : seats.find((s) => s.seat === mySeat)?.stackCents ?? 0;
  const action = deriveActionAvailability(handState, mySeat, myStack);
  const canActRef = useRef(action.canAct);
  const lastActionAtRef = useRef(0);

  useEffect(() => {
    canActRef.current = action.canAct;
    telemetry('action.ui.gated', {
      canAct: action.canAct,
      canCheck: action.canCheck,
      canCall: action.canCall,
      canBet: action.canBet,
      canRaise: action.canRaise,
    });
  }, [action.canAct, action.canCheck, action.canCall, action.canBet, action.canRaise]);

  useEffect(() => {
    if (!pending) return;
    const updated: any = handState && (handState as any).updatedAt;
    if (updated?.toMillis && updated.toMillis() > lastActionAtRef.current) {
      setPending(false);
    }
  }, [handState?.updatedAt, pending]);

  if (!handState) return null;

  const label = action.canCheck
    ? 'Check'
    : `Call $${(action.callAmount / 100).toFixed(2)}`;

  const logGuard = () => {
    telemetry('action.guard', {
      canAct: action.canAct,
      callAmount: action.callAmount,
      seat: mySeat,
      toAct: handState?.toActSeat,
      street: handState?.street,
    });
  };

  const handlePrimary = async () => {
    logGuard();
    if (!action.canAct) return;
    if (!action.canCheck && !action.canCall) return;
    setPending(true);
    lastActionAtRef.current = Date.now();
    try {
      if (action.canCheck) {
        telemetry('action.check.start', { seat: mySeat });
        await onCheck();
        telemetry('action.check.ok', { seat: mySeat });
      } else if (action.canCall) {
        telemetry('action.call.start', { seat: mySeat, amount: action.callAmount });
        await onCall(action.callAmount);
        telemetry('action.call.ok', { seat: mySeat, amount: action.callAmount });
      }
    } catch (e: any) {
      const reason = e?.message || 'error';
      const event = action.canCheck ? 'action.check.fail' : 'action.call.fail';
      telemetry(event, { seat: mySeat, reason });
      setPending(false);
    }
  };

  const handleFold = async () => {
    logGuard();
    if (!action.canFold) return;
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
        disabled={!action.canAct || (!action.canCheck && !action.canCall) || pending}
        onClick={handlePrimary}
        title={!action.canAct ? 'Not your turn' : undefined}
      >
        {label}
      </button>
      <button
        disabled={!action.canFold || pending}
        onClick={handleFold}
        title={!action.canAct ? 'Not your turn' : undefined}
      >
        Fold
      </button>
    </div>
  );
};
