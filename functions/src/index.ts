// Minimal Cloud Functions scaffold (gen2) — placeholder triggers
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { onDocumentWritten, onDocumentUpdated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";

initializeApp();
const db = getFirestore();

// Simple HTTP ping for sanity checks
export const ping = onRequest({ region: "us-central1" }, (req, res) => {
  res.status(200).send("pong");
});

// Placeholder: fires when any seat changes
export const onSeatsChanged = onDocumentWritten(
  { region: "us-central1", document: "tables/{tableId}/seats/{playerId}" },
  async (event) => {
    logger.info("onSeatsChanged fired", { params: event.params });
    // no-op for now
  }
);

// Placeholder: fires when table doc changes (for nextVariantId, etc.)
export const onVariantChosen = onDocumentUpdated(
  { region: "us-central1", document: "tables/{tableId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if ((before?.nextVariantId ?? null) !== (after?.nextVariantId ?? null)) {
      logger.info("nextVariantId changed", {
        tableId: event.params.tableId,
        nextVariantId: after?.nextVariantId ?? null
      });
    }
  }
);

// Placeholder: fires when a hand status changes
export const onHandEnded = onDocumentUpdated(
  { region: "us-central1", document: "tables/{tableId}/hands/{handId}" },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (before?.status !== "ended" && after?.status === "ended") {
      logger.info("hand ended", { params: event.params });
    }
  }
);
