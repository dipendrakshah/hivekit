/**
 * @hivekit/connectors — site(git) · x(X API v2) · email(IMAP/SMTP) (stream 04).
 *
 * Locked design (ARCHITECTURE §4.5): credentials are dereferenced inside the
 * tool executor, outside any model's view; every irreversible action produces
 * an audit receipt (who/what/when/model/approved-by).
 *
 * Stream 01 ships connector identity only — enough for Settings → Connectors
 * to enumerate what exists and for doctor to name checks that will land with
 * stream 04.
 */

export const CONNECTOR_IDS = ["site", "x", "email"] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];