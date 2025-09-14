export type TelemetryEvent = string;
export type TelemetryPayload = Record<string, unknown>;

export function telemetry(event: TelemetryEvent, payload: TelemetryPayload = {}): void {
  if (typeof window !== 'undefined' && (window as any).jamlog) {
    (window as any).jamlog.push(event, payload);
  } else {
    console.log(event, payload); // fallback for non-browser environments
  }
}
