export type TelemetryEvent = string;
export type TelemetryPayload = Record<string, unknown>;

const JAMLOG_THROTTLE_MS = 500;
const THROTTLED_EVENTS = new Set<TelemetryEvent>(['turn.snapshot', 'action.guard']);
const THROTTLE_KEYS = ['toActSeat', 'street', 'handNo', 'toMatch', 'myCommit'] as const;
type ThrottleKey = (typeof THROTTLE_KEYS)[number];

interface ThrottleEntry {
  lastAt: number;
  lastSignature: string | null;
}

const throttleState: Record<TelemetryEvent, ThrottleEntry> = {};

function shouldEmit(event: TelemetryEvent, payload: TelemetryPayload): boolean {
  if (!THROTTLED_EVENTS.has(event)) return true;
  const now = Date.now();
  const entry = throttleState[event] ?? { lastAt: 0, lastSignature: null };
  const relevant = {} as Record<ThrottleKey, unknown>;
  for (const key of THROTTLE_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : undefined;
    relevant[key] = value === undefined ? null : value;
  }
  const signature = JSON.stringify(relevant);
  const first = entry.lastSignature === null;
  const changed = signature !== entry.lastSignature;
  const elapsed = now - entry.lastAt;
  const reasonValue = payload['reason'] as string | undefined | null;
  const reasonNonOk = typeof reasonValue === 'string' && reasonValue !== 'ok';
  if (!(first || elapsed >= JAMLOG_THROTTLE_MS || changed || reasonNonOk)) {
    return false;
  }
  throttleState[event] = { lastAt: now, lastSignature: signature };
  return true;
}

export function telemetry(event: TelemetryEvent, payload: TelemetryPayload = {}): void {
  if (!shouldEmit(event, payload)) return;
  if (typeof window !== 'undefined' && (window as any).jamlog) {
    (window as any).jamlog.push(event, payload);
  } else {
    console.log(event, payload); // fallback for non-browser environments
  }
}
