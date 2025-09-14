import React, { useState } from 'react';
import { HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';
import { computeActionState, Seat } from '../table/computeActionState';

export interface TableActionsProps {
  uid: string;
  seats: Seat[];
  handState: HandState | null;
  onCheck: () => Promise<void>;
  onCall: (toCall: number) => Promise<void>;
}

export const TableActions: React.FC<TableActionsProps> = ({ uid, seats, handState, onCheck, onCall }) => {
  const [locked, setLocked] = useState(false);
  const action = computeActionState({ uid, seats, handState });
  if (!handState) return null;

  const disabled = locked || !action.enabled;
  const callAmount = action.deltaToCall ?? 0;
  const label = callAmount === 0 ? 'Check' : `Call $${(callAmount / 100).toFixed(2)}`;

  const logGuard = (state = action) => {
    telemetry('action.guard', {
      reason: state.reason,
      seatIndex: state.seatIndex,
      toAct: state.toAct,
      street: handState?.street,
      betToMatchCents: state.betToMatch,
      myCommitCents: state.myCommit,
      deltaToCall: state.deltaToCall,
      stackCents: state.stack,
    });
  };

  const lock = () => {
    setLocked(true);
    setTimeout(() => setLocked(false), 600);
  };

  const handlePrimary = async () => {
    const state = computeActionState({ uid, seats, handState });
    logGuard(state);
    if (!state.enabled) return;

    lock();
    try {
      if (state.deltaToCall === 0 && state.canCheck) {
        telemetry('action.check.start', {
          seatIndex: state.seatIndex,
          betToMatchCents: state.betToMatch,
          myCommitCents: state.myCommit,
        });
        await onCheck();
        telemetry('action.check.ok', {
          seatIndex: state.seatIndex,
          betToMatchCents: state.betToMatch,
          myCommitCents: state.myCommit,
        });
      } else if (state.canCall) {
        telemetry('action.call.start', {
          seatIndex: state.seatIndex,
          deltaToCall: state.deltaToCall,
          betToMatchCents: state.betToMatch,
          myCommitCents: state.myCommit,
        });
        await onCall(state.deltaToCall || 0);
        telemetry('action.call.ok', {
          seatIndex: state.seatIndex,
          deltaToCall: state.deltaToCall,
          betToMatchCents: state.betToMatch,
          myCommitCents: state.myCommit,
        });
      }
    } catch (e: any) {
      const reason = e?.message || 'error';
      const event = state.deltaToCall === 0 ? 'action.check.fail' : 'action.call.fail';
      telemetry(event, {
        seatIndex: state.seatIndex,
        deltaToCall: state.deltaToCall,
        betToMatchCents: state.betToMatch,
        myCommitCents: state.myCommit,
        reason,
      });
    }
  };

  return (
    <div>
      <button
        disabled={disabled}
        onClick={handlePrimary}
        title={!action.enabled ? 'Not your turn' : undefined}
      >
        {label}
      </button>
    </div>
  );
};
