/**
 * Phase 5 — server-side enrollment operations (DB + audit).
 *
 * The single place that allocates official identifiers, so BOTH entry points
 * that may issue them use exactly the same mechanism:
 *
 *   app/api/admin/students/[id]/review   action "verify"  → issues them as part
 *                                        of approving the application
 *   app/api/admin/students/[id]/enroll   → issues the missing ones for an
 *                                        already-approved application (repair)
 *   scripts/repair-enrollment-identifiers.ts → the same operation for existing
 *                                        approved records
 *
 * Guarantees
 * ----------
 * - Identifier VALUES always come from an atomic counter allocation
 *   (`Counter.findOneAndUpdate({ _id }, { $inc }, { upsert: true })`) and are
 *   formatted by the pure rules in lib/enrollment.ts. Nothing is derived from a
 *   document count, a timestamp, randomness, a max scan, or client input.
 * - Only the identifiers that are actually MISSING are allocated; an issued
 *   identifier is never overwritten or replaced.
 * - Concurrency: the counter allocation is atomic, and the Student write is a
 *   single conditional `findOneAndUpdate` whose filter re-asserts the exact
 *   state that was read. A competing operation therefore loses the update
 *   instead of overwriting an assignment.
 * - Transactions: when the deployment supports them (a replica set or mongos)
 *   the whole operation runs in one transaction, so the counters roll back if
 *   anything fails. A STANDALONE deployment (which cannot run transactions at
 *   all) falls back to the same atomic single-document operations — the
 *   allocation stays unique and the student write stays all-or-nothing, but a
 *   failed operation may leave a gap in the sequence (never a duplicate).
 * - Audit: one EnrollmentEvent is appended per successful allocation, in the
 *   same transaction when transactions are available. On the fallback path the
 *   audit insert is best-effort — a failure is logged and never turns a
 *   persisted approval into a reported failure.
 *
 * This module is server-only (it imports Mongoose models). The pure rules it
 * uses live in lib/enrollment.ts.
 */

import { NextResponse } from "next/server";
import mongoose from "mongoose";
import Counter from "@/models/Counter";
import EnrollmentEvent, {
  type EnrollmentEventAction,
} from "@/models/EnrollmentEvent";
import Student, { type IStudent } from "@/models/Student";
import {
  ENROLLMENT_COUNTER_ID,
  decideEnrollment,
  formatEnrollmentNumber,
  formatUniversityRollNumber,
  planIdentifierAssignment,
  universityRollCounterId,
  type IdentifierPlan,
} from "@/lib/enrollment";
import { approvalAccountActivation } from "@/lib/student-review";

/* ── Abort signal ────────────────────────────────────────────────────────── */

/**
 * A safe, already-decided outcome used to end the operation with an HTTP
 * result. Every throw happens either before any write or inside a transaction,
 * so an abort never leaves a partially written record behind.
 */
export class EnrollmentAbort extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EnrollmentAbort";
    this.status = status;
  }
}

export type Session = mongoose.ClientSession | null;

/** Add the transaction session to query options only when there is one. */
function withSession<T extends object>(options: T, session: Session): T {
  return (session ? { ...options, session } : options) as T;
}

/** Load a student inside the operation's session (when present). */
export function findStudentWithSession(id: string, session: Session) {
  const query = Student.findById(id);
  return session ? query.session(session) : query;
}

/** True when the error is the driver's "transactions unsupported" (code 20). */
export function isTransactionUnsupportedError(error: unknown): boolean {
  const unwrapped = unwrapError(error) as { code?: number } | null;
  return unwrapped?.code === 20;
}

/**
 * Normalise an error: mongoose/driver helpers may rethrow a wrapped error, so
 * an EnrollmentAbort is looked for in `error` and in `error.cause`.
 */
export function unwrapError(error: unknown): unknown {
  if (error instanceof EnrollmentAbort) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause ?? error;
}

let transactionSupport: boolean | null = null;

/**
 * Run one enrollment operation, inside a multi-document transaction when the
 * deployment supports it.
 *
 * The first attempt decides the deployment's capability: a code-20 error means
 * this database cannot run transactions (standalone), and the SAME callback is
 * re-run without a session. The result is cached for the process, so only the
 * first operation pays for the probe and later ones never retry a transaction.
 *
 * Re-running is safe: on the transactional attempt the callback's writes are
 * discarded (never applied), so no counter value is consumed and no record is
 * changed before the fallback runs.
 */
export async function runEnrollmentOperation<T>(
  fn: (session: Session) => Promise<T>
): Promise<T> {
  if (transactionSupport === false) return fn(null);

  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(() => fn(session));
    transactionSupport = true;
    return result;
  } catch (error) {
    if (isTransactionUnsupportedError(error)) {
      transactionSupport = false;
      console.warn(
        "Enrollment: this MongoDB deployment does not support multi-document " +
          "transactions (standalone). Using the atomic single-document path: " +
          "atomic counter allocation plus a conditional student update."
      );
      return fn(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/* ── Sequence allocation ─────────────────────────────────────────────────── */

/**
 * Allocate the next value of one counter namespace with a single atomic `$inc`
 * (upsert on first use). Concurrent requests cannot receive the same value.
 */
async function allocateSequence(
  counterId: string,
  session: Session
): Promise<number | null> {
  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { nextValue: 1 } },
    withSession({ upsert: true, new: true, setDefaultsOnInsert: true }, session)
  );

  if (!counter || typeof counter.nextValue !== "number") return null;
  return counter.nextValue;
}

async function nextEnrollmentNumber(session: Session): Promise<string> {
  const sequence = await allocateSequence(ENROLLMENT_COUNTER_ID, session);
  const formatted = sequence === null ? null : formatEnrollmentNumber(sequence);
  if (!formatted) {
    throw new EnrollmentAbort(
      409,
      "The global enrollment number sequence is exhausted (EN99999999 has been reached). No identifier was assigned."
    );
  }
  return formatted;
}

async function nextUniversityRollNumber(
  admissionYear: number,
  session: Session
): Promise<string> {
  const sequence = await allocateSequence(
    universityRollCounterId(admissionYear),
    session
  );
  const formatted =
    sequence === null
      ? null
      : formatUniversityRollNumber(admissionYear, sequence);
  if (!formatted) {
    throw new EnrollmentAbort(
      409,
      `The ${admissionYear} university roll number sequence is exhausted (MSU${admissionYear}999999 has been reached). No identifier was assigned.`
    );
  }
  return formatted;
}

/** The plan shapes that still need at least one identifier. */
export type AllocatablePlan = Extract<
  IdentifierPlan,
  { ok: true; mode: "allocate_both" | "repair_roll" | "repair_enrollment" }
>;

export interface IdentifierAllocationResult {
  enrollmentNumber: string;
  universityRollNumber: string;
  admissionYear: number;
  /** True when this operation GENERATED the value (false = reused). */
  assignedEnrollmentNumber: boolean;
  assignedUniversityRollNumber: boolean;
}

/**
 * Allocate only the identifiers the plan reports as missing, reusing the ones
 * the record already carries. Throws EnrollmentAbort when a sequence is
 * exhausted, in which case no identifier is written by the caller.
 */
export async function allocateMissingIdentifiers(
  plan: AllocatablePlan,
  session: Session
): Promise<IdentifierAllocationResult> {
  if (plan.mode === "allocate_both") {
    const enrollmentNumber = await nextEnrollmentNumber(session);
    const universityRollNumber = await nextUniversityRollNumber(
      plan.admissionYear,
      session
    );
    return {
      enrollmentNumber,
      universityRollNumber,
      admissionYear: plan.admissionYear,
      assignedEnrollmentNumber: true,
      assignedUniversityRollNumber: true,
    };
  }

  if (plan.mode === "repair_roll") {
    const universityRollNumber = await nextUniversityRollNumber(
      plan.admissionYear,
      session
    );
    return {
      enrollmentNumber: plan.enrollmentNumber,
      universityRollNumber,
      admissionYear: plan.admissionYear,
      assignedEnrollmentNumber: false,
      assignedUniversityRollNumber: true,
    };
  }

  /* repair_enrollment — the roll number already exists and carries the year. */
  const enrollmentNumber = await nextEnrollmentNumber(session);
  return {
    enrollmentNumber,
    universityRollNumber: plan.universityRollNumber,
    admissionYear: plan.admissionYear,
    assignedEnrollmentNumber: true,
    assignedUniversityRollNumber: false,
  };
}

/* ── Assigning the missing identifiers of an approved record ─────────────── */

/**
 * Matches a field that carries NO issued identifier: absent, null or an empty
 * string. An empty string is not an issued identifier, so it may be filled —
 * while a malformed non-empty value is never matched (and never overwritten).
 */
const NOT_ISSUED = { $in: [null, ""] } as const;

/**
 * The identifier filter re-asserts what was read: the field(s) this operation
 * is about to write must still be exactly as observed, and the identifier being
 * preserved must still hold the same issued value.
 */
function identifierFilter(
  plan: Extract<ReturnType<typeof planIdentifierAssignment>, { ok: true }>
): Record<string, unknown> {
  if (plan.mode === "allocate_both") {
    return { enrollmentNumber: NOT_ISSUED, universityRollNumber: NOT_ISSUED };
  }
  if (plan.mode === "repair_roll") {
    return {
      enrollmentNumber: plan.enrollmentNumber,
      universityRollNumber: NOT_ISSUED,
    };
  }
  if (plan.mode === "repair_enrollment") {
    return {
      enrollmentNumber: NOT_ISSUED,
      universityRollNumber: plan.universityRollNumber,
    };
  }
  // Both identifiers are already present — nothing may be written.
  return {};
}

export interface AssignIdentifiersInput {
  studentId: string;
  /** Authenticated admin performing the assignment (audit identity). */
  actorAdminId: string;
  actorRole: string;
  /** Audit action recorded on the appended EnrollmentEvent. */
  action: EnrollmentEventAction;
}

export type AssignIdentifiersOutcome =
  | { kind: "already_complete"; student: IStudent }
  | {
      kind: "assigned";
      student: IStudent;
      allocation: IdentifierAllocationResult;
      operationId: string;
    };

/**
 * Assign the official identifiers an APPROVED student is missing.
 *
 * The approved record moves to `enrolled`, keeps the identifier(s) it already
 * carries, receives the missing one(s) from the atomic sequence allocation, and
 * has a still-unactivated (`pending`) account activated — all in one conditional
 * update, so a concurrent change makes the write a no-op instead of a
 * duplicate/overwrite.
 *
 * Throws EnrollmentAbort for every state this must refuse:
 *   - not found                                     → 404
 *   - not approved (pending / needs_correction / rejected) → 409
 *   - legacy record with no stored status           → 409
 *   - malformed / contradictory identifiers         → 409
 *   - incomplete registration / invalid admission year → 422
 *   - "enrolled" but carrying NO identifiers at all → 409 (manual remediation)
 * An approved record that already carries both valid identifiers is an
 * idempotent `already_complete`: nothing is allocated.
 */
export async function assignMissingIdentifiers(
  input: AssignIdentifiersInput
): Promise<AssignIdentifiersOutcome> {
  return runEnrollmentOperation<AssignIdentifiersOutcome>(async (session) => {
    const current = await findStudentWithSession(input.studentId, session);
    if (!current) {
      throw new EnrollmentAbort(404, "Student not found.");
    }

    const decision = decideEnrollment(current);
    if (!decision.ok) {
      throw new EnrollmentAbort(decision.status, decision.message);
    }
    if (decision.mode === "already_enrolled") {
      return { kind: "already_complete", student: current };
    }

    /* Which identifiers are missing? (Pure and consistent with the decision.) */
    const plan = planIdentifierAssignment(current);
    if (!plan.ok) {
      throw new EnrollmentAbort(plan.status, plan.message);
    }
    if (plan.mode === "none") {
      throw new EnrollmentAbort(
        409,
        "This student already carries both official identifiers. Nothing was changed."
      );
    }

    const now = new Date();
    const allocation = await allocateMissingIdentifiers(plan, session);

    const updated = await Student.findOneAndUpdate(
      {
        _id: input.studentId,
        applicationStatus: "verified",
        ...identifierFilter(plan),
      },
      {
        $set: {
          applicationStatus: "enrolled",
          enrollmentNumber: allocation.enrollmentNumber,
          universityRollNumber: allocation.universityRollNumber,
          enrolledAt: now,
          enrolledBy: input.actorAdminId,
          ...(approvalAccountActivation(current.accountStatus) ?? {}),
        },
      },
      withSession({ new: true, runValidators: true }, session)
    );

    if (!updated) {
      throw new EnrollmentAbort(
        409,
        "This application changed while its official identifiers were being assigned (it is no longer a verified application missing those identifiers). Reload and try again."
      );
    }

    const operationId = await createEnrollmentEvent({
      action: input.action,
      studentId: updated._id,
      actorAdminId: input.actorAdminId,
      actorRole: input.actorRole,
      enrollmentNumber: allocation.enrollmentNumber,
      universityRollNumber: allocation.universityRollNumber,
      admissionYear: allocation.admissionYear,
      session,
    });

    return { kind: "assigned", student: updated, allocation, operationId };
  });
}

/* ── Audit event ─────────────────────────────────────────────────────────── */

export interface EnrollmentEventInput {
  action: EnrollmentEventAction;
  studentId: mongoose.Types.ObjectId | string;
  actorAdminId: string;
  actorRole: string;
  enrollmentNumber: string;
  universityRollNumber: string;
  admissionYear: number;
  session: Session;
}

/**
 * Append the enrollment audit event and return its operation id.
 *
 * Inside a transaction an insert failure aborts the whole operation (the
 * caller's transaction rolls back). On the non-transactional fallback the
 * student write has already been committed by the time this runs, so a failed
 * audit insert is logged instead of failing an operation that DID persist —
 * the record is correct either way, and reporting a failure would be a lie.
 */
export async function createEnrollmentEvent(
  input: EnrollmentEventInput
): Promise<string> {
  const operationId = new mongoose.Types.ObjectId().toString();
  const document = {
    action: input.action,
    studentId: input.studentId,
    actorAdminId: input.actorAdminId,
    actorRole: input.actorRole,
    enrollmentNumber: input.enrollmentNumber,
    universityRollNumber: input.universityRollNumber,
    admissionYear: input.admissionYear,
    operationId,
    at: new Date(),
  };

  if (input.session) {
    await EnrollmentEvent.create([document], { session: input.session });
    return operationId;
  }

  try {
    await EnrollmentEvent.create([document]);
  } catch (error) {
    console.error(
      "Enrollment audit event could not be written (the enrollment itself is committed):",
      error
    );
  }
  return operationId;
}

/* ── Failure mapping ─────────────────────────────────────────────────────── */

export interface EnrollmentFailureMessages {
  /** A duplicate official identifier was rejected by the database. */
  duplicate: string;
  /** A write was attempted without the required atomic guarantee. */
  transactionUnavailable: string;
  /** A competing request won the write. */
  concurrent: string;
  /** Anything unexpected. */
  generic: string;
}

export interface EnrollmentFailureOptions {
  studentId?: string | null;
  messages: EnrollmentFailureMessages;
  /**
   * Called for a duplicate-key error only: lets the caller re-read the record
   * and answer with the persisted result instead of a spurious failure.
   */
  onDuplicateKey?: (studentId: string) => Promise<NextResponse | null>;
}

/**
 * Map a failure to a safe HTTP result. Never exposes internals, never claims a
 * partial success, and never reports success when nothing was persisted.
 */
export async function enrollmentFailureResponse(
  error: unknown,
  options: EnrollmentFailureOptions
): Promise<NextResponse> {
  const unwrapped = unwrapError(error);

  if (unwrapped instanceof EnrollmentAbort) {
    return NextResponse.json(
      { success: false, message: unwrapped.message },
      { status: unwrapped.status }
    );
  }

  const err = unwrapped as {
    name?: string;
    code?: number;
    hasErrorLabel?: (label: string) => boolean;
  };

  if (err?.code === 11000) {
    if (options.onDuplicateKey && options.studentId) {
      const resolved = await options.onDuplicateKey(options.studentId);
      if (resolved) return resolved;
    }
    return NextResponse.json(
      { success: false, message: options.messages.duplicate },
      { status: 409 }
    );
  }

  if (err?.code === 20) {
    console.error(
      "Enrollment: the database cannot provide the required atomic guarantee.",
      error
    );
    return NextResponse.json(
      { success: false, message: options.messages.transactionUnavailable },
      { status: 500 }
    );
  }

  if (err?.hasErrorLabel?.("TransientTransactionError")) {
    return NextResponse.json(
      { success: false, message: options.messages.concurrent },
      { status: 409 }
    );
  }

  console.error("Enrollment error:", error);
  return NextResponse.json(
    { success: false, message: options.messages.generic },
    { status: 500 }
  );
}
