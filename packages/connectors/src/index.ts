/**
 * @hivekit/connectors — the three v1 connectors + web tools (§4.5, FR-K).
 *
 * One factory wires every tool into a fresh bus; executors get their secrets
 * via injected getters so nothing credential-shaped is ever stored here.
 * `fs.write` (repo-jailed) registers ONLY when the site connector does —
 * the gateway composes a single bus and must never double-register.
 */
export { SsrfBlocked, ssrfFetch, wrapUntrusted, wrapUntrustedExternal, isForbiddenIp } from "./web";
export { extractFeed, makeWebTools } from "./webtools";
export type { FeedItem } from "./webtools";
export { SiteRepo, makeSiteTools } from "./site";
export { makeXTools, signOAuth1 } from "./x";
export type { XCredentials } from "./x";
export { sendMail } from "./smtp";
export { makeEmailTools, realImapPoller } from "./email";
export type { MailboxPoller, FetchOne } from "./email";
