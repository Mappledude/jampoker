export function logEvent(type, ctx) {
  if (window.jamlog) {
    window.jamlog.push(type, ctx);
  }
}
