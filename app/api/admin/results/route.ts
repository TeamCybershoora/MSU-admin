import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Result, { toSafeResult, type IResult } from "@/models/Result";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex, parseSemesterNumber } from "@/lib/validation";
import { SUBJECT_TYPES, type SubjectType } from "@/lib/programme-structure";
import {
  buildResultSubject,
  calculateCGPA,
  computeResultFigures,
  curriculumResultFigures,
  equivalentPercentage,
  formatCgpa,
  gradeForMarks,
  semesterResultStatus,
  subjectStatus,
  type ResultSubject,
  type SubjectStatusInput,
} from "@/lib/result-grading";
import {
  resolveSemester,
  resolveStructure,
  resolveSubject,
} from "@/lib/syllabus-academic";

/**
 * GET /api/admin/results
 *
 * List, search, and filter result records.
 * Query params: search, status, page, limit, resultId
 * Protected: requires admin JWT.
 */

const adminResultLimiter = createRateLimiter({
  name: "admin-results",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const resultId = url.searchParams.get("resultId")?.trim() || "";

    // ── Single-result fetch (for Edit form) ──
    if (resultId) {
      if (!mongoose.Types.ObjectId.isValid(resultId)) {
        return NextResponse.json(
          { success: false, message: "Invalid Result ID format." },
          { status: 400 }
        );
      }

      const result = await Result.findById(resultId).lean() as unknown as IResult | null;
      if (!result) {
        return NextResponse.json(
          { success: false, message: "Result not found." },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        data: {
          id: result._id,
          student: {
            name: result.student.name,
            rollNumber: result.student.rollNumber,
            enrollmentNumber: result.student.enrollmentNumber,
            course: result.student.course,
            semester: result.student.semester,
            academicSession: result.student.academicSession,
            collegeName: result.student.collegeName,
            fatherName: result.student.fatherName ?? "",
            motherName: result.student.motherName ?? "",
            gender: result.student.gender ?? "",
          },
          curriculum: result.curriculum
            ? {
                programmeCode: result.curriculum.programmeCode,
                semesterNumber: result.curriculum.semesterNumber,
              }
            : null,
          subjects: result.subjects.map((s) => ({
            subjectCode: s.subjectCode,
            subjectName: s.subjectName,
            internalMarks: s.internalMarks,
            externalMarks: s.externalMarks,
            totalMarks: s.totalMarks,
            maxMarks: s.maxMarks,
            grade: s.grade,
            gradePoint: s.gradePoint,
            credits: s.credits,
            subjectType: s.subjectType ?? null,
            isBacklog: s.isBacklog,
            isAbsent: s.isAbsent === true,
          })),
          totalMarks: result.totalMarks,
          maxTotalMarks: result.maxTotalMarks,
          percentage: result.percentage,
          sgpa: result.sgpa ?? null,
          cgpa: result.cgpa,
          equivalentPercentage: result.equivalentPercentage ?? null,
          resultStatus: result.resultStatus,
          remarks: result.remarks,
          declaredDate: result.declaredDate,
          createdAt: result.createdAt,
        },
      });
    }

    // ── List/search/filter ──
    const search = url.searchParams.get("search")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (search) {
      query.$or = [
        { "student.name": { $regex: escapeRegex(search), $options: "i" } },
        { "student.rollNumber": { $regex: escapeRegex(search), $options: "i" } },
        { "student.enrollmentNumber": { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    if (status) {
      query.resultStatus = status.toUpperCase();
    }

    const [results, total] = await Promise.all([
      Result.find(query)
        // `_id` tie-break so separate page queries keep a stable order for
        // results created in the same instant (no duplicates/gaps between pages).
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Result.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: results.map((r) => ({
        id: r._id,
        student: {
          name: r.student.name,
          rollNumber: r.student.rollNumber,
          enrollmentNumber: r.student.enrollmentNumber,
          course: r.student.course,
          semester: r.student.semester,
        },
        totalMarks: r.totalMarks,
        maxTotalMarks: r.maxTotalMarks,
        percentage: r.percentage,
        sgpa: r.sgpa ?? null,
        cgpa: r.cgpa,
        resultStatus: r.resultStatus,
        declaredDate: r.declaredDate,
        createdAt: r.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin results list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load results." },
      { status: 500 }
    );
  }
}

/* ── Validation helpers ─────────────────────────────────────────── */

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}


function validateSubject(
  sub: unknown,
  index: number
): { ok: true; subject: ResultSubject } | { ok: false; error: string } {
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
    return { ok: false, error: `Subject at index ${index} must be an object.` };
  }

  const s = sub as Record<string, unknown>;

  const subjectCode = trimString(s.subjectCode);
  const subjectName = trimString(s.subjectName);

  if (!subjectCode) return { ok: false, error: `Subject at index ${index}: subjectCode is required.` };
  if (!subjectName) return { ok: false, error: `Subject at index ${index}: subjectName is required.` };
  if (!isPositiveNumber(s.maxMarks)) return { ok: false, error: `Subject "${subjectCode}": maxMarks must be a positive number.` };
  if (!isNonNegativeNumber(s.credits)) return { ok: false, error: `Subject "${subjectCode}": credits must be a non-negative number.` };

  // Absence is the ONLY way a subject may omit its component marks.
  const isAbsent = s.isAbsent === true;
  if (!isAbsent && !isNonNegativeNumber(s.internalMarks)) return { ok: false, error: `Subject "${subjectCode}": internalMarks must be a non-negative number.` };
  if (!isAbsent && !isNonNegativeNumber(s.externalMarks)) return { ok: false, error: `Subject "${subjectCode}": externalMarks must be a non-negative number.` };

  const internalMarks = isAbsent ? 0 : (s.internalMarks as number);
  const externalMarks = isAbsent ? 0 : (s.externalMarks as number);
  const totalMarks = internalMarks + externalMarks;

  if (totalMarks > (s.maxMarks as number)) {
    return { ok: false, error: `Subject "${subjectCode}": internal + external marks cannot exceed the maximum (${s.maxMarks}).` };
  }

  // Grade and grade point are DERIVED here. Any client-supplied grade,
  // gradePoint, totalMarks or percentage is ignored by construction.
  const { grade, gradePoint } = gradeForMarks(totalMarks, isAbsent);

  // Snapshot passthrough: keep the curriculum's subject type when the request
  // carries one (an unknown value is dropped rather than stored).
  const rawType = typeof s.subjectType === "string" ? s.subjectType.trim().toUpperCase() : "";
  const subjectType = (SUBJECT_TYPES as readonly string[]).includes(rawType)
    ? (rawType as SubjectType)
    : null;

  return {
    ok: true,
    subject: {
      subjectCode,
      subjectName,
      internalMarks,
      externalMarks,
      totalMarks,
      maxMarks: s.maxMarks as number,
      grade,
      gradePoint,
      credits: s.credits as number,
      subjectType,
      isBacklog: s.isBacklog === true,
      isAbsent,
    },
  };
}

/**
 * Derive the semester result status from the subjects (server-authoritative).
 *
 *   FAIL when any subject is "Fail" or "Absent"; PASS otherwise. A Compartment
 *   subject does NOT fail the semester. The client's resultStatus is never read.
 */
function derivedResultStatus(subjects: readonly unknown[]): "PASS" | "FAIL" {
  return semesterResultStatus(
    subjects.map((subject) => subjectStatus(subject as SubjectStatusInput))
  );
}

/* ── Curriculum resolution (Phase 3A) ───────────────────────── */


interface CurriculumInput {
  programmeCode: string;
  academicSession: string;
  semesterNumber: number;
}

interface CurriculumSnapshot {
  programmeCode: string;
  semesterNumber: number;
}

/** Validate the optional curriculum identity a request selected. */
function parseCurriculumInput(
  raw: unknown
): { ok: true; data: CurriculumInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "curriculum must be an object." };
  }
  const c = raw as Record<string, unknown>;
  const programmeCode = trimString(c.programmeCode);
  const academicSession = trimString(c.academicSession);
  const semesterNumber = parseSemesterNumber(c.semesterNumber);

  if (!programmeCode || !academicSession || semesterNumber === null) {
    return {
      ok: false,
      error:
        "curriculum must include programmeCode, academicSession and semesterNumber.",
    };
  }
  return { ok: true, data: { programmeCode, academicSession, semesterNumber } };
}

/**
 * Resolve a selected curriculum identity against ProgrammeStructure and build
 * the subject SNAPSHOT for a Result.
 *
 * ProgrammeStructure is the source of truth: the subject NAME, CREDITS, TYPE
 * and ASSESSMENT MAXIMUM always come from the resolved structure, never from the
 * request. Only the marks and grade a student actually obtained are taken from
 * the admin. Internal + external still forms the subject total exactly as the
 * existing Result flow already defined it — no grade/SGPA/CGPA logic is added.
 */
async function buildCurriculumSubjects(
  curriculum: CurriculumInput,
  rawSubjects: unknown
): Promise<
  | {
      ok: true;
      data: {
        subjects: Record<string, unknown>[];
        curriculum: CurriculumSnapshot;
        studentPatch: {
          course: string;
          semester: string;
          academicSession: string;
        };
      };
    }
  | { ok: false; status: number; error: string }
> {
  const structureResult = await resolveStructure(
    curriculum.programmeCode,
    curriculum.academicSession,
    { requireActive: true }
  );
  if (!structureResult.ok) {
    return {
      ok: false,
      status: structureResult.status,
      error: structureResult.message,
    };
  }
  const { structure } = structureResult.data;

  const semesterResult = resolveSemester(structure, curriculum.semesterNumber, {
    requireActive: true,
  });
  if (!semesterResult.ok) {
    return { ok: false, status: semesterResult.status, error: semesterResult.message };
  }
  const semester = semesterResult.data.semester;

  if (!Array.isArray(rawSubjects) || rawSubjects.length === 0) {
    return { ok: false, status: 400, error: "At least one subject is required." };
  }

  const subjects: Record<string, unknown>[] = [];
  const seenCodes = new Set<string>();
  const seenGroups = new Map<string, string>();

  for (let i = 0; i < rawSubjects.length; i++) {
    const raw = rawSubjects[i] as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: `Subject at index ${i} must be an object.` };
    }

    const subjectCode = trimString(raw.subjectCode);
    if (!subjectCode) {
      return {
        ok: false,
        status: 400,
        error: `Subject at index ${i}: subjectCode is required.`,
      };
    }

    const resolved = resolveSubject(structure, semester.semesterNumber, subjectCode, {
      requireActive: true,
    });
    if (!resolved.ok) {
      return { ok: false, status: resolved.status, error: resolved.message };
    }
    const meta = resolved.data.subject;

    // Assessment maximum is curriculum metadata, never client-supplied.
    const maxMarks = meta.assessment?.totalMax ?? 0;
    if (!isPositiveNumber(maxMarks)) {
      return {
        ok: false,
        status: 409,
        error: `Subject "${meta.subjectCode}" has no assessment maximum in Academic Structure, so a Result cannot be recorded against it.`,
      };
    }

    // Phase 3B: subject total, percentage and grade point are computed HERE,
    // server-side, from the snapshot + marks. The letter grade is manual
    // passthrough; any client gradePoint/totalMarks/percentage is ignored.
    const built = buildResultSubject(
      {
        subjectCode: meta.subjectCode,
        subjectName: meta.subjectName,
        credits: meta.credits,
        maxMarks,
        subjectType: meta.subjectType,
        // Component maxima come from the curriculum, never the request, so the
        // server can validate internal/external against the subject's own split.
        internalMax: meta.assessment?.internalMax ?? null,
        externalMax: meta.assessment?.externalMax ?? null,
        practicalMax: meta.assessment?.practicalMax ?? null,
      },
      {
        internalMarks: raw.internalMarks,
        externalMarks: raw.externalMarks,
        // Absence is an explicit input; grade/gradePoint/total/percentage
        // are NEVER read from the request.
        isAbsent: raw.isAbsent,
        isBacklog: raw.isBacklog,
      }
    );
    if (!built.ok) {
      return { ok: false, status: 400, error: built.error };
    }

    const key = meta.subjectCode.toUpperCase();
    if (seenCodes.has(key)) {
      return {
        ok: false,
        status: 409,
        error: `Subject ${meta.subjectCode} appears more than once.`,
      };
    }
    seenCodes.add(key);

    // Elective options are ALTERNATIVES: only one per group may be recorded.
    if (meta.electiveGroup) {
      if (seenGroups.has(meta.electiveGroup)) {
        return {
          ok: false,
          status: 409,
          error: `Only one subject may be chosen from elective group ${meta.electiveGroup}.`,
        };
      }
      seenGroups.set(meta.electiveGroup, meta.subjectCode);
    }

    subjects.push(built.subject as unknown as Record<string, unknown>);
  }

  return {
    ok: true,
    data: {
      subjects,
      curriculum: {
        programmeCode: structure.programmeCode,
        semesterNumber: semester.semesterNumber,
      },
      studentPatch: {
        course: structure.programmeName,
        semester:
          semester.semesterName?.trim() || `Semester ${semester.semesterNumber}`,
        academicSession: curriculum.academicSession,
      },
    },
  };
}

/* ── Cumulative CGPA (Phase 3C) ─────────────────────────────────── */

/**
 * The persisted identity that groups one student's semester Results.
 *
 * enrollmentNumber is the stable university identity and is preferred over
 * roll number (a roll number can be reassigned); name is NEVER used. The
 * programme and academic session scope the chain so another programme or
 * another session can never contribute credits to this student's CGPA.
 */
interface StudentCgpaIdentity {
  enrollmentNumber: string;
  programmeCode: string;
  academicSession: string;
}

function cgpaIdentity(input: {
  enrollmentNumber: string;
  programmeCode: string;
  academicSession: string;
}): StudentCgpaIdentity {
  return {
    enrollmentNumber: input.enrollmentNumber.trim().toUpperCase(),
    programmeCode: input.programmeCode.trim().toUpperCase(),
    academicSession: input.academicSession.trim(),
  };
}

/**
 * Match the same student, programme and academic session. `curriculum: $ne
 * null` is implied by the programme-code clause, so legacy Results (no
 * snapshot) are never pulled into a cumulative calculation.
 */
function cgpaQuery(identity: StudentCgpaIdentity): Record<string, unknown> {
  return {
    "student.enrollmentNumber": identity.enrollmentNumber,
    "student.academicSession": identity.academicSession,
    "curriculum.programmeCode": identity.programmeCode,
  };
}

/** A stored Result reduced to what the cumulative calculation actually needs. */
interface CgpaLeanResult {
  _id: mongoose.Types.ObjectId;
  curriculum: { programmeCode: string; semesterNumber: number } | null;
  subjects: { credits: number; gradePoint: number }[];
  cgpa: string | null;
  equivalentPercentage: number | null;
}

/**
 * Detect a duplicate semester before writing.
 *
 * Two curriculum-linked Results for the same student + programme + session +
 * semester are an ambiguity: neither may be silently chosen for the CGPA.
 * Returns the offending semester number, or null when unambiguous. The
 * incoming Result is counted as one of the pair (that is how an update that
 * would create a duplicate is caught), and the row being updated is excluded
 * so editing it in place is not mistaken for a duplicate.
 */
async function findDuplicateSemester(
  identity: StudentCgpaIdentity,
  incomingSemesterNumber: number,
  excludeId?: string
): Promise<number | null> {
  const query = cgpaQuery(identity);
  if (excludeId) query._id = { $ne: excludeId };

  const docs = (await Result.find(query)
    .select({ "curriculum.semesterNumber": 1 })
    .lean()) as unknown as { curriculum: { semesterNumber: number } | null }[];

  const counts = new Map<number, number>();
  for (const doc of docs) {
    const semesterNumber = doc.curriculum?.semesterNumber;
    if (typeof semesterNumber !== "number") continue;
    counts.set(semesterNumber, (counts.get(semesterNumber) ?? 0) + 1);
  }
  counts.set(
    incomingSemesterNumber,
    (counts.get(incomingSemesterNumber) ?? 0) + 1
  );

  for (const [semesterNumber, count] of counts) {
    if (count > 1) return semesterNumber;
  }
  return null;
}

type CgpaSyncResult =
  | {
      ok: true;
      bySemester: Map<number, string | null>;
      equivalentBySemester: Map<number, number | null>;
    }
  | { ok: false; duplicateSemester: number };

/**
 * Recompute the whole cumulative CGPA chain for one student's programme +
 * session and persist the authoritative value on EVERY included semester
 * Result.
 *
 * Because CGPA is cumulative, changing an early semester changes the
 * cumulative value of every later one, so the chain is recomputed in
 * ascending `curriculum.semesterNumber` order and each prefix's
 * credit-weighted CGPA is written back. This is a small synchronous pass over
 * one student's Results (at most a handful of documents) — no queue, job or
 * mass-update architecture.
 *
 * On a duplicate semester the function refuses to guess and reports the
 * offending semester instead of updating anything.
 */
async function syncCumulativeCgpa(
  identity: StudentCgpaIdentity
): Promise<CgpaSyncResult> {
  const docs = (await Result.find(cgpaQuery(identity))
    .sort({ "curriculum.semesterNumber": 1 })
    .lean()) as unknown as CgpaLeanResult[];

  const counts = new Map<number, number>();
  for (const doc of docs) {
    const semesterNumber = doc.curriculum?.semesterNumber;
    if (typeof semesterNumber !== "number") continue;
    counts.set(semesterNumber, (counts.get(semesterNumber) ?? 0) + 1);
  }
  for (const [semesterNumber, count] of counts) {
    if (count > 1) return { ok: false, duplicateSemester: semesterNumber };
  }

  const bySemester = new Map<number, string | null>();
  const equivalentBySemester = new Map<number, number | null>();
  const included: { semesterNumber: number; subjects: { credits: number; gradePoint: number }[] }[] =
    [];
  const updates: Promise<unknown>[] = [];

  for (const doc of docs) {
    const semesterNumber = doc.curriculum?.semesterNumber;
    if (typeof semesterNumber !== "number") continue;

    included.push({ semesterNumber, subjects: doc.subjects ?? [] });

    // Credit-weighted CGPA through every semester included so far.
    const cgpaNumber = calculateCGPA(included);
    const cgpa = formatCgpa(cgpaNumber);
    bySemester.set(semesterNumber, cgpa);

    // Equivalent percentage is always derived from the cumulative CGPA.
    const equivalent = equivalentPercentage(cgpaNumber);
    equivalentBySemester.set(semesterNumber, equivalent);

    // Only write when a stored value actually changed.
    if (
      (doc.cgpa ?? null) !== cgpa ||
      (doc.equivalentPercentage ?? null) !== equivalent
    ) {
      updates.push(
        Result.updateOne(
          { _id: doc._id },
          { $set: { cgpa, equivalentPercentage: equivalent } }
        )
      );
    }
  }

  if (updates.length > 0) await Promise.all(updates);

  return { ok: true, bySemester, equivalentBySemester };
}

/** Shared 409 for an ambiguous duplicate semester. */
function duplicateSemesterResponse(semesterNumber: number) {
  return NextResponse.json(
    {
      success: false,
      message: `A Result for Semester ${semesterNumber} already exists for this student, programme and academic session. Resolve the duplicate before recording the result again.`,
    },
    { status: 409 }
  );
}

async function validateResultBody(
  body: unknown
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; status?: number }
> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }

  const b = body as Record<string, unknown>;

  if (!b.student || typeof b.student !== "object" || Array.isArray(b.student)) {
    return { ok: false, error: "Student information is required." };
  }

  const student = b.student as Record<string, unknown>;
  const studentFields = ["name", "rollNumber", "enrollmentNumber", "course", "semester", "academicSession", "collegeName"] as const;
  // Optional identity fields: stored on the snapshot, may be left blank (the
  // printed statement then shows an em dash). Never invented, never required.
  const optionalStudentFields = ["fatherName", "motherName", "gender"] as const;

  const cleanedStudent: Record<string, string> = {};
  for (const field of studentFields) {
    const val = trimString(student[field]);
    if (!val) return { ok: false, error: `Student field "${field}" is required.` };
    cleanedStudent[field] = val;
  }
  for (const field of optionalStudentFields) {
    cleanedStudent[field] = trimString(student[field]) ?? "";
  }

  // ── Subjects ──────────────────────────────────────────────
  // With a curriculum identity the subjects are resolved from
  // ProgrammeStructure (server authority) and snapshotted; without one the
  // existing manual path is preserved for editing pre-integration Results.
  let cleanedSubjects: Record<string, unknown>[] = [];
  let curriculumSnapshot: CurriculumSnapshot | null = null;

  if (b.curriculum !== undefined && b.curriculum !== null) {
    const parsed = parseCurriculumInput(b.curriculum);
    if (!parsed.ok) return parsed;

    const built = await buildCurriculumSubjects(parsed.data, b.subjects);
    if (!built.ok) return { ok: false, error: built.error, status: built.status };

    cleanedSubjects = built.data.subjects;
    curriculumSnapshot = built.data.curriculum;
    // The programme name/session/semester label shown on the statement come
    // from the resolved structure, not from the request.
    cleanedStudent.course = built.data.studentPatch.course;
    cleanedStudent.semester = built.data.studentPatch.semester;
    cleanedStudent.academicSession = built.data.studentPatch.academicSession;
  } else {
    if (!Array.isArray(b.subjects) || b.subjects.length === 0) {
      return { ok: false, error: "At least one subject is required." };
    }

    for (let i = 0; i < b.subjects.length; i++) {
      const result = validateSubject(b.subjects[i], i);
      if (!result.ok) return result;
      cleanedSubjects.push(result.subject);
    }
  }

  let totalMarks: number;
  let maxTotalMarks: number;
  let percentage: number;
  let sgpa: number | null;
  let cgpa: string | null;
  let equivalent: number | null;

  if (curriculumSnapshot) {
    // Phase 3B/3C: curriculum-linked headline figures are computed from the
    // subjects only — client totalMarks/maxTotalMarks/percentage/sgpa/cgpa
    // are ignored. `cgpa` is a placeholder here (null): the caller's
    // cumulative sync writes the authoritative value from the student's
    // semester Results after the document is saved.
    const figures = curriculumResultFigures(
      cleanedSubjects as unknown as Parameters<typeof curriculumResultFigures>[0]
    );
    totalMarks = figures.totalMarks;
    maxTotalMarks = figures.maxTotalMarks;
    percentage = figures.percentage;
    sgpa = figures.sgpa;
    cgpa = null;
    equivalent = null;
  } else {
    // Legacy (no curriculum snapshot): the client may still describe its own
    // subjects, but EVERY derived figure is computed here. Client-supplied
    // totalMarks, maxTotalMarks, percentage, sgpa and cgpa are ignored.
    const legacyFigures = computeResultFigures(
      cleanedSubjects as unknown as Parameters<typeof computeResultFigures>[0]
    );
    totalMarks = legacyFigures.totalMarks;
    maxTotalMarks = legacyFigures.maxTotalMarks;
    percentage = legacyFigures.percentage;
    sgpa = legacyFigures.sgpa;
    cgpa = null;
    equivalent = null;
  }

  // The semester result status is DERIVED here from the subjects — FAIL when a
  // subject is Fail/Absent, otherwise PASS. A Compartment subject never decides
  // the semester, and a client-supplied resultStatus is ignored by construction.
  const resultStatus = derivedResultStatus(cleanedSubjects);

  const remarks = trimString(b.remarks) ?? "";
  const declaredDate = trimString(b.declaredDate);
  if (!declaredDate) return { ok: false, error: "declaredDate is required." };

  return {
    ok: true,
    data: {
      student: cleanedStudent,
      curriculum: curriculumSnapshot,
      subjects: cleanedSubjects,
      totalMarks, maxTotalMarks,
      percentage, sgpa, cgpa, equivalentPercentage: equivalent,
      resultStatus, remarks, declaredDate,
    },
  };
}

/* ── POST /api/admin/results ────────────────────────────────────── */

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();

    const validation = await validateResultBody(body);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, message: validation.error },
        { status: validation.status ?? 400 }
      );
    }

    // Phase 3C: a curriculum-linked write participates in the cumulative CGPA
    // chain for the student's programme + session. Detect a duplicate semester
    // BEFORE writing so an ambiguous record is never created.
    const curriculum = validation.data.curriculum as CurriculumSnapshot | null;
    const student = validation.data.student as Record<string, string>;

    const identity = curriculum
      ? cgpaIdentity({
          enrollmentNumber: student.enrollmentNumber,
          programmeCode: curriculum.programmeCode,
          academicSession: student.academicSession,
        })
      : null;

    if (identity && curriculum) {
      const duplicate = await findDuplicateSemester(
        identity,
        curriculum.semesterNumber
      );
      if (duplicate !== null) return duplicateSemesterResponse(duplicate);
    }

    const result = await Result.create(validation.data);

    if (identity && curriculum) {
      const sync = await syncCumulativeCgpa(identity);
      if (!sync.ok) {
        // Should be unreachable after the pre-check, but never leave an
        // ambiguous record behind.
        await Result.findByIdAndDelete(result._id);
        return duplicateSemesterResponse(sync.duplicateSemester);
      }
      // Store the authoritative cumulative value on the created Result.
      result.cgpa = sync.bySemester.get(curriculum.semesterNumber) ?? null;
      result.equivalentPercentage =
        sync.equivalentBySemester.get(curriculum.semesterNumber) ?? null;
    }

    return NextResponse.json({
      success: true,
      message: "Result created successfully.",
      result: toSafeResult(result),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin result create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create result." },
      { status: 500 }
    );
  }
}

/* ── PUT /api/admin/results ─────────────────────────────────────── */

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { resultId } = body as Record<string, unknown>;

    if (!resultId || typeof resultId !== "string") {
      return NextResponse.json(
        { success: false, message: "Result ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(resultId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Result ID format." },
        { status: 400 }
      );
    }

    const result = await Result.findById(resultId);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "Result not found." },
        { status: 404 }
      );
    }

    // Apply updates from the body
    if (body.student && typeof body.student === "object") {
      const student = body.student as Record<string, string>;
      const optionalStudentFields = new Set(["fatherName", "motherName", "gender"]);
      for (const [key, value] of Object.entries(student)) {
        if (typeof value !== "string") continue;
        // Optional identity fields may be CLEARED, so an empty value is applied
        // for them; every other field keeps the existing non-empty-only rule.
        if (value.trim() || optionalStudentFields.has(key)) {
          (result.student as Record<string, unknown>)[key] = value.trim();
        }
      }
    }

    let revalidated: { ok: true; data: Record<string, unknown> } | { ok: false; error: string; status?: number } | null = null;

    if (Array.isArray(body.subjects)) {
      // A Result that already carries a curriculum snapshot is re-validated
      // against it: the subjects are re-resolved from ProgrammeStructure and
      // the curriculum identity is re-applied, so a client can neither swap
      // the subjects nor downgrade the Result to the legacy path. An explicit
      // `curriculum` in the body still wins (create-style edits).
      const validationBody: Record<string, unknown> = { ...body };
      if (body.curriculum === undefined && result.curriculum) {
        validationBody.curriculum = {
          programmeCode: result.curriculum.programmeCode,
          academicSession: result.student.academicSession,
          semesterNumber: result.curriculum.semesterNumber,
        };
      }

      const validation = await validateResultBody(validationBody);
      if (!validation.ok) {
        return NextResponse.json(
          { success: false, message: validation.error },
          { status: validation.status ?? 400 }
        );
      }
      revalidated = validation;
      result.subjects = validation.data.subjects as IResult["subjects"];
      // Only replace the snapshot when a curriculum was explicitly selected;
      // editing a pre-integration Result never clears or invents one.
      if (validation.data.curriculum) {
        result.curriculum = validation.data.curriculum as IResult["curriculum"];
      }
    }

    // The curriculum this Result belongs to, whether it arrived in the request
    // or was already stored on the document (Phase 3A snapshot).
    const effectiveCurriculum: CurriculumSnapshot | null =
      revalidated?.ok && revalidated.data.curriculum
        ? (revalidated.data.curriculum as CurriculumSnapshot)
        : result.curriculum
          ? {
              programmeCode: result.curriculum.programmeCode,
              semesterNumber: result.curriculum.semesterNumber,
            }
          : null;

    if (effectiveCurriculum) {
      // Phase 3B/3C: the curriculum-linked headline figures always come from
      // the just-validated subjects; client totalMarks/percentage/sgpa/cgpa are
      // ignored. CGPA is written by the cumulative sync below, so it can never
      // be left stale after an earlier semester changes.
      const figures = computeResultFigures(
        result.subjects as unknown as Parameters<typeof computeResultFigures>[0]
      );
      result.totalMarks = figures.totalMarks;
      result.maxTotalMarks = figures.maxTotalMarks;
      result.percentage = figures.percentage;
      result.sgpa = figures.sgpa;
    } else {
      // Legacy: derive every figure from the stored subjects. The client
      // totalMarks/maxTotalMarks/percentage/sgpa/cgpa are never trusted.
      const figures = computeResultFigures(
        result.subjects as unknown as Parameters<typeof computeResultFigures>[0]
      );
      result.totalMarks = figures.totalMarks;
      result.maxTotalMarks = figures.maxTotalMarks;
      result.percentage = figures.percentage;
      result.sgpa = figures.sgpa;
      result.cgpa = null;
      result.equivalentPercentage = null;
    }
    // Server-authoritative: the semester status always follows the stored
    // subjects. A client-supplied resultStatus is ignored.
    result.resultStatus = derivedResultStatus(result.subjects);
    if (typeof body.remarks === "string") result.remarks = body.remarks;
    if (typeof body.declaredDate === "string") result.declaredDate = body.declaredDate;

    if (effectiveCurriculum) {
      const identity = cgpaIdentity({
        enrollmentNumber: result.student.enrollmentNumber,
        programmeCode: effectiveCurriculum.programmeCode,
        academicSession: result.student.academicSession,
      });

      // Never write a duplicate-semester ambiguity; report it instead.
      const duplicate = await findDuplicateSemester(
        identity,
        effectiveCurriculum.semesterNumber,
        resultId
      );
      if (duplicate !== null) return duplicateSemesterResponse(duplicate);

      await result.save();

      const sync = await syncCumulativeCgpa(identity);
      if (!sync.ok) return duplicateSemesterResponse(sync.duplicateSemester);

      // Reflect the authoritative cumulative value in the response without a
      // second write (the sync already persisted it).
      result.cgpa = sync.bySemester.get(effectiveCurriculum.semesterNumber) ?? null;
      result.equivalentPercentage =
        sync.equivalentBySemester.get(effectiveCurriculum.semesterNumber) ?? null;
    } else {
      await result.save();
    }

    return NextResponse.json({
      success: true,
      message: "Result updated successfully.",
      result: toSafeResult(result as unknown as IResult),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin result update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update result." },
      { status: 500 }
    );
  }
}

/* ── DELETE /api/admin/results ──────────────────────────────────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminResultLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = await req.json();
    const { resultId } = body as Record<string, unknown>;

    if (!resultId || typeof resultId !== "string") {
      return NextResponse.json(
        { success: false, message: "Result ID is required." },
        { status: 400 }
      );
    }

    if (!mongoose.Types.ObjectId.isValid(resultId)) {
      return NextResponse.json(
        { success: false, message: "Invalid Result ID format." },
        { status: 400 }
      );
    }

    const result = await Result.findById(resultId);
    if (!result) {
      return NextResponse.json(
        { success: false, message: "Result not found." },
        { status: 404 }
      );
    }

    await Result.findByIdAndDelete(resultId);

    return NextResponse.json({
      success: true,
      message: "Result deleted successfully.",
    });
  } catch (error) {
    console.error("Admin result delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete result." },
      { status: 500 }
    );
  }
}
