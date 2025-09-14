import React, { useState } from 'react';
import { computeToCall, computeLegalActions, HandState } from '../poker/handMath';
import { telemetry } from '../telemetry';

export interface TableActionsProps {
  hand?: HandState | null;
  mySeat: number | null;
  onCheck: () => Promise<void>;
  onCall: (toCall: number) => Promise<void>;
}

export const TableActions: React.FC<TableActionsProps> = ({ hand, mySeat, onCheck, onCall }) => {
  const [locked, setLocked] = useState(false);
  if (hand == null || mySeat == null) return null;

  const toCall = computeToCall(hand, mySeat);
  const legal = computeLegalActions(hand, mySeat);
  const isActor = hand.toActSeat === mySeat;
  const disabled = locked || !isActor;
  const label = toCall === 0 ? 'Check' : `Call $${(toCall / 100).toFixed(2)}`;

  const guardFail = (type: 'check' | 'call', reason: string) => {
    telemetry(`action.${type}.fail`, { toCall, reason });
  };

  const lock = () => {
    setLocked(true);
    setTimeout(() => setLocked(false), 600);
  };

  const handleCheck = async () => {
    if (!isActor) return guardFail('check', 'not-your-turn');
    if (!legal.check) return guardFail('check', 'now-must-call');
    telemetry('action.check.start', { toCall });
    lock();
    try {
      await onCheck();
      telemetry('action.check.ok', { toCall });
    } catch (e: any) {
      telemetry('action.check.fail', { toCall, reason: e?.message || 'error' });
    }
  };

  const handleCall = async () => {
    if (!isActor) return guardFail('call', 'not-your-turn');
    if (!legal.call) return guardFail('call', 'no-call');
    telemetry('action.call.start', { toCall });
    lock();
    try {
      await onCall(toCall);
      telemetry('action.call.ok', { toCall });
    } catch (e: any) {
      telemetry('action.call.fail', { toCall, reason: e?.message || 'error' });
    }
  };

  return (
    <div>
      <button disabled={disabled || !legal.check} onClick={handleCheck}>
        Check
      </button>
      <button disabled={disabled || !legal.call} onClick={handleCall}>
        {label}
      </button>
    </div>
  );
};
