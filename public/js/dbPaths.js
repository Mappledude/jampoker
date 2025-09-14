// Single source of truth for Firestore paths used by the app.
export function handDocPath(tableId) {
  // If your app currently uses a different path, set it here.
  // Options we've seen in code/logs: "handState/current" or "hand/{handId}"
  return `tables/${tableId}/handState/current`;
}
