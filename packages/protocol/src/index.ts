/**
 * Hivekit wire protocol — the single source of truth for every frame that
 * crosses the WebSocket, plus the card shapes embedded in messages.
 *
 * Zod lives HERE and only here by design (ARCHITECTURE §1.1): schemas are
 * applied at the WS frame boundary and nowhere else. Inside the gateway,
 * parsed frames are plain typed objects.
 *
 * Frame list per ARCHITECTURE §4.1. Handlers for frames belonging to later
 * streams (jobs beyond echo, routines, models, connectors) are defined now
 * and answered with `res.error { code: "not_implemented" }` until their
 * stream lands — the protocol is complete, the runtime grows into it.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

export const ThreadRole = z.enum(["op", "master", "worker", "system"]);
export type ThreadRole = z.infer<typeof ThreadRole>;

export const JobStatus = z.enum([
  "planning",
  "running",
  "needs_approval",
  "merging",
  "done",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TaskStatus = z.enum(["queued", "running", "ok", "failed", "blocked"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ActionKind = z.enum(["site_push", "x_post", "email_send", "exec", "delete"]);
export type ActionKind = z.infer<typeof ActionKind>;

export const NotifyPolicy = z.enum(["always", "on-approval-only", "silent-until-done"]);

/** Idempotency keys on job.approve / job.cancel / routine.create (ARCH §4.1). */
export const IdempotencyKey = z.string().min(8).max(64).regex(/^[A-Za-z0-9._:-]+$/);

// ---------------------------------------------------------------------------
// Cards (Message.card_json payloads) — rendered inline in the thread
// ---------------------------------------------------------------------------

export const PlanCard = z.object({
  kind: z.literal("plan"),
  job_id: z.string(),
  title: z.string(),
  summary: z.string(),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: TaskStatus,
    }),
  ),
});
export type PlanCard = z.infer<typeof PlanCard>;

export const ApprovalCard = z.object({
  kind: z.literal("approval"),
  approval_id: z.string(),
  job_id: z.string(),
  action_kind: ActionKind,
  /** Human-readable preview: diff text, tweet body, email draft… */
  preview: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
});
export type ApprovalCard = z.infer<typeof ApprovalCard>;

export const QuestionCard = z.object({
  kind: z.literal("question"),
  job_id: z.string().nullable(),
  prompt: z.string(),
  options: z.array(z.string()).default([]),
});
export type QuestionCard = z.infer<typeof QuestionCard>;

export const Card = z.discriminatedUnion("kind", [PlanCard, ApprovalCard, QuestionCard]);
export type Card = z.infer<typeof Card>;

// ---------------------------------------------------------------------------
// Envelope — every frame is `{ v, id, type, payload }`
// ---------------------------------------------------------------------------

export const Frame = z
  .object({
    /** Protocol version. Server rejects mismatched majors. */
    v: z.literal(1),
    /** Client-generated request id; echoed in res frames for correlation. */
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    payload: z.unknown(),
  })
  .strict();
export type Frame = z.infer<typeof Frame>;

// ---------------------------------------------------------------------------
// Request payloads (req.*)
// ---------------------------------------------------------------------------

export const ReqHello = z.object({}).strict();
export type ReqHello = z.infer<typeof ReqHello>;

export const ReqChatSend = z
  .object({
    thread_id: z.string().min(1),
    body: z.string().min(1).max(32_000),
  })
  .strict();
export type ReqChatSend = z.infer<typeof ReqChatSend>;

export const ReqThreadCreate = z
  .object({
    title: z.string().min(1).max(200),
  })
  .strict();
export type ReqThreadCreate = z.infer<typeof ReqThreadCreate>;

export const ReqJobApprove = z
  .object({
    approval_id: z.string().min(1),
    key: IdempotencyKey,
  })
  .strict();
export type ReqJobApprove = z.infer<typeof ReqJobApprove>;

export const ReqJobDeny = ReqJobApprove;
export type ReqJobDeny = ReqJobApprove;

export const ReqJobCancel = z
  .object({
    job_id: z.string().min(1),
    key: IdempotencyKey,
  })
  .strict();
export type ReqJobCancel = z.infer<typeof ReqJobCancel>;

export const ReqRoutineCreate = z
  .object({
    name: z.string().min(1).max(100),
    cron: z.string().min(1).max(100),
    prompt_template: z.string().min(1).max(8_000),
    notify: NotifyPolicy.default("on-approval-only"),
    key: IdempotencyKey,
  })
  .strict();
export type ReqRoutineCreate = z.infer<typeof ReqRoutineCreate>;

export const ReqRoutinePause = z.object({ routine_id: z.string().min(1) }).strict();
export type ReqRoutinePause = z.infer<typeof ReqRoutinePause>;
export const ReqRoutineResume = ReqRoutinePause;
export type ReqRoutineResume = z.infer<typeof ReqRoutinePause>;

export const ReqModelsSet = z
  .object({
    master_model: z.string().min(1).max(200).optional(),
    worker_model: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((r) => r.master_model !== undefined || r.worker_model !== undefined, {
    message: "at least one of master_model / worker_model required",
  });
export type ReqModelsSet = z.infer<typeof ReqModelsSet>;

export const ReqConnectorSet = z
  .object({
    connector: z.enum(["site", "x", "email"]),
    credentials: z
      .record(z.string(), z.string())
      .refine((r) => Object.keys(r).length <= 32, {
        message: "credentials must have at most 32 keys",
      }),
  })
  .strict();
export type ReqConnectorSet = z.infer<typeof ReqConnectorSet>;

// ---------------------------------------------------------------------------
// Response + event payloads
// ---------------------------------------------------------------------------

export const SnapshotThread = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  created_at: z.string(),
});
export type SnapshotThread = z.infer<typeof SnapshotThread>;

export const SnapshotMessage = z.object({
  id: z.string(),
  thread_id: z.string(),
  role: ThreadRole,
  body: z.string(),
  card: Card.nullable(),
  artifact_refs: z.array(z.string()),
  created_at: z.string(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;

export const SnapshotJob = z.object({
  id: z.string(),
  thread_id: z.string(),
  title: z.string(),
  status: JobStatus,
  master_model: z.string().nullable(),
  worker_model: z.string().nullable(),
  usd: z.number().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
});
export type SnapshotJob = z.infer<typeof SnapshotJob>;

export const SnapshotRoutine = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  enabled: z.boolean(),
  notify: NotifyPolicy,
  next_run_at: z.string().nullable(),
});
export type SnapshotRoutine = z.infer<typeof SnapshotRoutine>;

export const Snapshot = z.object({
  you: z.object({ auth: z.enum(["passkey", "token"]) }).strict(),
  threads: z.array(SnapshotThread),
  messages: z.array(SnapshotMessage), // most recent thread's history
  jobs: z.array(SnapshotJob),
  routines: z.array(SnapshotRoutine),
  models: z.object({
    master: z.string().nullable(),
    worker: z.string().nullable(),
  }),
  server_time: z.string(),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const ResError = z.object({
  code: z.enum([
    "bad_frame",
    "unauthorized",
    "not_found",
    "conflict",
    "not_implemented",
    "internal",
  ]),
  message: z.string().max(500),
});
export type ResError = z.infer<typeof ResError>;

export const EventThreadMessage = z.object({ message: SnapshotMessage });
export type EventThreadMessage = z.infer<typeof EventThreadMessage>;

export const EventJob = z.object({ job: SnapshotJob });
export type EventJob = z.infer<typeof EventJob>;

export const EventApproval = z.object({ card: ApprovalCard, thread_id: z.string() });
export type EventApproval = z.infer<typeof EventApproval>;

// ---------------------------------------------------------------------------
// Frame-type → payload registry (compile-time exhaustive dispatch table)
// ---------------------------------------------------------------------------

export const FrameTypes = {
  "req.hello": ReqHello,
  "req.thread.create": ReqThreadCreate,
  "req.chat.send": ReqChatSend,
  "req.job.approve": ReqJobApprove,
  "req.job.deny": ReqJobDeny,
  "req.job.cancel": ReqJobCancel,
  "req.routine.create": ReqRoutineCreate,
  "req.routine.pause": ReqRoutinePause,
  "req.routine.resume": ReqRoutineResume,
  "req.models.set": ReqModelsSet,
  "req.connector.set": ReqConnectorSet,
} as const;

export type FrameType = keyof typeof FrameTypes;
export type FramePayload<T extends FrameType> = z.infer<(typeof FrameTypes)[T]>;

/** Frames the gateway accepts but does not yet act on (later streams). */
export const NotYetImplemented: readonly string[] = [
  "req.connector.set",
  "req.models.set",
  "req.routine.create",
  "req.routine.pause",
  "req.routine.resume",
];

/** Events are server→client only; clients must never send them. */
export const EventTypes = ["event.thread", "event.job", "event.approval"] as const;
export type EventType = (typeof EventTypes)[number];