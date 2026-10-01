import { NextResponse } from "next/server";
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import ProgrammeStructure, {
  toSafeProgrammeStructure,
  toSafeProgrammeStructureSummary,
  type IProgrammeSubject,
  type IProgrammeSemester,
  type IProgrammeStructure,
} from "@/models/ProgrammeStructure";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { escapeRegex, parseSemesterNumber } from "@/lib/validation";
import {
  MAX_SEMESTERS_PER_STRUCTURE,
  STRUCTURE_STATUSES,
  findDuplicateSubjectCode,
  isStructureStatus,
  parseAcademicSession,
  parseProgrammeStructureFields,
  parseSemesterInput,
  parseSemesterList,
  parseSubjectInput,
  resolveStructureDeleteDecision,
  type SemesterInput,
  type SubjectInput,
} from "@/lib/programme-structure";

/**
 * Academic Structure / Programme Curriculum — admin API.
 *
 * This is the master-data API for Phase 1: programme → academic session →
 * semester → subject → academic metadata (credits, type, assessment maximums).
 * It stores no student marks, no grades and no SGPA/CGPA, and it deliberately
 * does not read or write the existing Syllabus or Result collections.
 *
 * ROUTES
 *   GET    /api/admin/academic-structure
 *            ?id=<objectId>                                  → one structure (full)
 *            ?programmeCode=BCA&academicSession=2025-26      → one structure (full)
 *            (no identifier)                                 → paginated list
 *              &search= &status=ACTIVE|INACTIVE &page= &limit=
 *   POST   /api/admin/academic-structure
 *            { programmeCode, programmeName, academicSession, status?, semesters? }
 *   PATCH  /api/admin/academic-structure
 *            { id } + one operation at a time:
 *              { programmeName }            rename the programme
 *              { status }                   activate / deactivate the structure
 *              { semesters: [...] }         replace the whole semester list
 *              { semester, originalSemesterNumber? }  add or edit ONE semester
 *              { semesterNumber, subject, originalSubjectCode? }  add or edit ONE subject
 *   DELETE /api/admin/academic-structure
 *            ?id=…&semesterNumber=4&subjectCode=CS401&confirm=permanent  → one subject
 *            ?id=…&semesterNumber=4&confirm=permanent                    → one semester
 *            ?id=…&scope=structure&confirm=permanent                     → whole structure
 *
 * WHY THE IDENTITY IS IMMUTABLE:
 * `programmeCode` + `academicSession` is the key this curriculum is identified
 * by — it is what a later Syllabus/Result phase will query with. Renaming it in
 * place would silently repoint every future consumer, so the pair is fixed once
 * created (a corrected curriculum is a new structure; the old one is deactivated,
 * never rewritten in place).
 *
 * FUTURE INTEGRATION CONTRACT (NOT IMPLEMENTED IN THIS PHASE):
 *   GET ?programmeCode=…&academicSession=…   returns the structure whose
 *   `semesters[].subjects[]` carry subjectCode, subjectName, credits,
 *   subjectType, assessment and status. ProgrammeStructure.listSelectableSubjects()
 *   returns only effectively-active subjects for one semester. Syllabus will use
 *   those subjects to attach documents and Result will use them to create
 *   student result rows — and a Result record must SNAPSHOT the subject data it
 *   read at creation time, so curriculum edits never rewrite declared results.
 *
 * SECURITY: every method requires an admin JWT (authenticateAdmin) and is rate
 * limited. ObjectIds and bodies are validated server-side; internal errors are
 * logged and returned as generic messages.
 */

const adminStructureLimiter = createRateLimiter({
  name: "admin-academic-structure",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

/* ── Small request helpers ─────────────────────────────────────── */

function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

/** Parse `?page=`/`?limit=` without ever producing NaN (unlike a bare parseInt). */
function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return body && typeof body === "object" ? body : null;
}

/**
 * Flatten a stored subject (subdocument or lean document) to a plain object.
 *
 * Every stored field must be carried over, otherwise an unrelated edit (say,
 * renaming a subject) would silently drop election-group membership, category,
 * minimum marks or the qualifying-internal flag. Used when a request edits ONE
 * semester or subject and the rest of the list has to be re-saved unchanged.
 */
function toPlainSubject(subject: IProgrammeSubject): SubjectInput {
  return {
    subjectCode: subject.subjectCode,
    subjectName: subject.subjectName,
    credits: subject.credits,
    subjectType: subject.subjectType,
    category: subject.category ?? "CORE",
    status: subject.status,
    electiveGroup: subject.electiveGroup || "",
    selectionRule: subject.selectionRule ?? null,
    assessment: {
      internalMax: subject.assessment.internalMax,
      externalMax: subject.assessment.externalMax,
      practicalMax: subject.assessment.practicalMax,
      totalMax: subject.assessment.totalMax,
      minimumMarks: subject.assessment.minimumMarks ?? null,
      internalQualifying: subject.assessment.internalQualifying ?? false,
    },
  };
}

/**
 * Locate ONE structure for a read or mutation. Addressed by ObjectId (what the
 * admin UI uses) or by the natural key programmeCode + academicSession.
 */
async function loadStructure(params: {
  id?: unknown;
  programmeCode?: unknown;
  academicSession?: unknown;
}): Promise<{ document: IProgrammeStructure } | { error: NextResponse }> {
  if (params.id !== undefined && params.id !== null && params.id !== "") {
    if (typeof params.id !== "string" || !mongoose.isValidObjectId(params.id)) {
      return { error: fail("A valid programme structure id is required.") };
    }

    const document = await ProgrammeStructure.findById(params.id);
    if (!document) {
      return { error: fail("Programme structure not found.", 404) };
    }
    return { document };
  }

  const programmeCode =
    typeof params.programmeCode === "string"
      ? params.programmeCode.trim().toUpperCase()
      : "";
  const academicSession = parseAcademicSession(params.academicSession);

  if (!programmeCode || !academicSession) {
    return {
      error: fail(
        "Provide the programme structure id, or both programmeCode and academicSession."
      ),
    };
  }

  const document = await ProgrammeStructure.findOne({ programmeCode, academicSession });
  if (!document) {
    return { error: fail("Programme structure not found.", 404) };
  }
  return { document };
}

/**
 * One place for write-failure responses: duplicate key → 409, Mongoose
 * validation → 400 with the field messages, anything else → 500 with a generic
 * message (the details stay in the server log).
 */
function handleWriteError(error: unknown, action: "create" | "update") {
  const err = error as {
    name?: string;
    code?: number;
    errors?: Record<string, { message: string }>;
  };

  if (err.code === 11000) {
    return fail(
      "A programme structure for that programme and academic session already exists.",
      409
    );
  }

  if (err.name === "ValidationError" && err.errors) {
    return fail(Object.values(err.errors).map((entry) => entry.message).join(" "));
  }

  console.error(`Admin academic structure ${action} error:`, error);
  return fail(
    action === "create"
      ? "Unable to create programme structure."
      : "Unable to update programme structure.",
    500
  );
}

/* ── GET ───────────────────────────────────────────────────────── */

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStructureLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const id = url.searchParams.get("id")?.trim() || "";
    const programmeCodeParam = url.searchParams.get("programmeCode")?.trim() || "";
    const academicSessionParam = url.searchParams.get("academicSession")?.trim() || "";

    // ── One structure (by id, or by the programme + session natural key) ──
    if (id || (programmeCodeParam && academicSessionParam)) {
      const loaded = await loadStructure({
        id: id || undefined,
        programmeCode: programmeCodeParam || undefined,
        academicSession: academicSessionParam || undefined,
      });
      if ("error" in loaded) return loaded.error;

      return NextResponse.json({
        success: true,
        data: toSafeProgrammeStructure(loaded.document),
      });
    }

    // ── Paginated list of programme structures ────────────────────────────
    const search = url.searchParams.get("search")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const page = parsePositiveInt(url.searchParams.get("page"), 1, 100000);
    const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 100);
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (status && isStructureStatus(status)) {
      query.status = status;
    }

    if (programmeCodeParam) {
      query.programmeCode = programmeCodeParam.toUpperCase();
    }

    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [
        { programmeCode: pattern },
        { programmeName: pattern },
        { academicSession: pattern },
      ];
    }

    const [structures, total, programmes, academicSessions] = await Promise.all([
      ProgrammeStructure.find(query)
        .sort({ programmeCode: 1, academicSession: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ProgrammeStructure.countDocuments(query),
      ProgrammeStructure.distinct("programmeCode"),
      ProgrammeStructure.distinct("academicSession"),
    ]);

    return NextResponse.json({
      success: true,
      // Mapped explicitly (never spread) so only public fields can travel and
      // the list stays a compact summary — the curriculum itself is sent only
      // for a single structure.
      data: structures.map((structure) =>
        toSafeProgrammeStructureSummary({
          _id: structure._id,
          programmeCode: structure.programmeCode,
          programmeName: structure.programmeName,
          academicSession: structure.academicSession,
          status: structure.status,
          semesters: (structure.semesters ?? []) as IProgrammeSemester[],
          createdAt: structure.createdAt,
          updatedAt: structure.updatedAt,
        })
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        statuses: STRUCTURE_STATUSES,
        programmes: programmes.sort(),
        academicSessions: academicSessions.sort().reverse(),
      },
    });
  } catch (error) {
    console.error("Admin academic structure list error:", error);
    return fail("Unable to load programme structures.", 500);
  }
}

/* ── POST — create one programme structure ─────────────────────── */

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStructureLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = await readJsonBody(req);
    if (!body) return fail("Invalid request body.");

    const fields = parseProgrammeStructureFields(body);
    if (!fields.ok) return fail(fields.message);

    const semesters = parseSemesterList(body.semesters);
    if (!semesters.ok) return fail(semesters.message);

    // Duplicate protection: programmeCode + academicSession identifies exactly
    // one curriculum. Checked first for a readable message, then guaranteed by
    // the unique index even under concurrent creates (11000 below).
    const existing = await ProgrammeStructure.findOne({
      programmeCode: fields.data.programmeCode,
      academicSession: fields.data.academicSession,
    }).lean();

    if (existing) {
      return fail(
        `A programme structure for ${fields.data.programmeCode} (${fields.data.academicSession}) already exists.`,
        409
      );
    }

    const structure = await ProgrammeStructure.create({
      ...fields.data,
      semesters: semesters.data,
    });

    return NextResponse.json(
      {
        success: true,
        message: "Programme structure created successfully.",
        structure: toSafeProgrammeStructure(structure),
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    return handleWriteError(error, "create");
  }
}

/* ── PATCH — partial, identifier-based updates ─────────────────── */

export async function PATCH(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStructureLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = await readJsonBody(req);
    if (!body) return fail("Invalid request body.");

    const loaded = await loadStructure({
      id: body.id,
      programmeCode: body.programmeCode,
      academicSession: body.academicSession,
    });
    if ("error" in loaded) return loaded.error;

    const structure = loaded.document;
    const touched: string[] = [];

    // ── Identity is immutable (see the header comment) ─────────────
    const requestedCode =
      typeof body.programmeCode === "string"
        ? body.programmeCode.trim().toUpperCase()
        : "";
    const requestedSession = parseAcademicSession(body.academicSession);

    if (requestedCode && requestedCode !== structure.programmeCode) {
      return fail(
        "The programme code cannot be changed. Deactivate this structure and create a new one instead — Syllabus and Result will address this curriculum by programme code + academic session."
      );
    }
    if (requestedSession && requestedSession !== structure.academicSession) {
      return fail(
        "The academic session cannot be changed. Deactivate this structure and create a new one instead — Syllabus and Result will address this curriculum by programme code + academic session."
      );
    }

    // ── Programme name ────────────────────────────────────────────
    if (body.programmeName !== undefined) {
      if (typeof body.programmeName !== "string" || !body.programmeName.trim()) {
        return fail("Programme name cannot be empty.");
      }
      if (body.programmeName.trim().length > 150) {
        return fail("Programme name cannot exceed 150 characters.");
      }
      structure.programmeName = body.programmeName.trim();
      touched.push("programmeName");
    }

    // ── Structure status (ACTIVE ⇄ INACTIVE) ──────────────────────
    // Deactivating is a single-field update: child semesters/subjects keep their
    // own stored status and simply become effectively inactive (effectiveStatus).
    if (body.status !== undefined) {
      if (!isStructureStatus(body.status)) {
        return fail(`Status must be one of ${STRUCTURE_STATUSES.join(", ")}.`);
      }
      structure.status = body.status;
      touched.push("status");
    }

    // ── Replace the whole semester list ───────────────────────────
    if (body.semesters !== undefined) {
      const semesters = parseSemesterList(body.semesters);
      if (!semesters.ok) return fail(semesters.message);

      replaceSemesters(structure, semesters.data);
      touched.push("semesters");
    }

    // ── Add OR edit ONE semester ──────────────────────────────────
    // The operation is chosen by the request (never by looking the number up):
    //   originalSemesterNumber present → EDIT that semester
    //   originalSemesterNumber absent  → ADD a new semester (duplicate = 409)
    if (body.semester !== undefined) {
      const parsed = parseSemesterInput(body.semester);
      if (!parsed.ok) return fail(parsed.message);

      const hasOriginal = body.originalSemesterNumber !== undefined;
      const originalNumber = hasOriginal
        ? parseSemesterNumber(body.originalSemesterNumber)
        : null;

      if (hasOriginal && originalNumber === null) {
        return fail("A valid semester number is required to edit a semester.");
      }

      const index =
        originalNumber === null
          ? -1
          : structure.semesters.findIndex(
              (entry) => entry.semesterNumber === originalNumber
            );

      if (originalNumber !== null && index === -1) {
        return fail(`Semester ${originalNumber} was not found in this structure.`, 404);
      }

      // Adding needs room; without this a 13th semester could be pushed in.
      if (index === -1 && structure.semesters.length >= MAX_SEMESTERS_PER_STRUCTURE) {
        return fail(
          `A programme structure cannot have more than ${MAX_SEMESTERS_PER_STRUCTURE} semesters.`,
          409
        );
      }

      const clash = structure.semesters.some(
        (entry, i) => i !== index && entry.semesterNumber === parsed.data.semesterNumber
      );
      if (clash) {
        return fail(`Semester ${parsed.data.semesterNumber} already exists.`, 409);
      }

      // An edit that does not mention `subjects` keeps the existing subject list
      // intact — editing a semester's label or status never touches its subjects.
      const keepExistingSubjects =
        (body.semester as Record<string, unknown>).subjects === undefined;
      const subjects =
        keepExistingSubjects && index !== -1
          ? structure.semesters[index].subjects.map(toPlainSubject)
          : parsed.data.subjects;

      const nextSemester: SemesterInput = {
        semesterNumber: parsed.data.semesterNumber,
        semesterName: parsed.data.semesterName,
        status: parsed.data.status,
        subjects,
      };

      // Built from the CURRENT list before it is replaced, so every other
      // semester (with its own subjects) is carried over unchanged.
      replaceSemesters(
        structure,
        [...existingSemestersExcept(structure, originalNumber), nextSemester]
      );
      touched.push("semester");
    }

    // ── Add OR edit ONE subject ───────────────────────────────────
    if (body.subject !== undefined) {
      const semesterNumber = parseSemesterNumber(body.semesterNumber);
      if (semesterNumber === null) {
        return fail("A valid semester number is required to manage a subject.");
      }

      const semester = structure.semesters.find(
        (entry) => entry.semesterNumber === semesterNumber
      );
      if (!semester) {
        return fail(`Semester ${semesterNumber} was not found in this structure.`, 404);
      }

      const parsed = parseSubjectInput(body.subject);
      if (!parsed.ok) return fail(parsed.message);

      const originalCode =
        typeof (body.subject as Record<string, unknown>).originalSubjectCode === "string"
          ? ((body.subject as Record<string, unknown>).originalSubjectCode as string).trim()
          : "";

      const subjects: SubjectInput[] = semester.subjects.map(toPlainSubject);
      const subjectIndex = originalCode
        ? subjects.findIndex(
            (subject) =>
              subject.subjectCode.toUpperCase() === originalCode.toUpperCase()
          )
        : -1;

      if (originalCode && subjectIndex === -1) {
        return fail(
          `Subject ${originalCode} was not found in Semester ${semesterNumber}.`,
          404
        );
      }

      const candidateSubjects =
        subjectIndex === -1
          ? [...subjects, parsed.data]
          : subjects.map((subject, i) => (i === subjectIndex ? parsed.data : subject));

      // Subject codes are unique INSIDE one semester only — the same code may
      // legitimately exist in another semester, programme or session.
      const duplicate = findDuplicateSubjectCode(candidateSubjects);
      if (duplicate) {
        return fail(
          `Subject code ${duplicate} already exists in Semester ${semesterNumber}.`,
          409
        );
      }

      semester.subjects.splice(0, semester.subjects.length);
      for (const subject of candidateSubjects) {
        semester.subjects.push(subject);
      }
      touched.push("subject");
    }

    if (touched.length === 0) {
      return fail("No supported fields to update.");
    }

    await structure.save();

    return NextResponse.json({
      success: true,
      message: "Programme structure updated successfully.",
      structure: toSafeProgrammeStructure(structure),
      updated: touched,
    });
  } catch (error: unknown) {
    return handleWriteError(error, "update");
  }
}

/** Replace every semester of a loaded structure with the given list. */
function replaceSemesters(
  structure: IProgrammeStructure,
  semesters: SemesterInput[]
): void {
  structure.semesters.splice(0, structure.semesters.length);
  for (const semester of semesters) {
    structure.semesters.push(semester);
  }
}

/**
 * Every existing semester except the one being replaced, as plain input
 * objects. Used when adding or editing a single semester so the other
 * semesters (and their subjects) are carried over untouched.
 */
function existingSemestersExcept(
  structure: IProgrammeStructure,
  replacedNumber: number | null
): SemesterInput[] {
  return structure.semesters
    .filter((entry) => entry.semesterNumber !== replacedNumber)
    .map((entry) => ({
      semesterNumber: entry.semesterNumber,
      semesterName: entry.semesterName || "",
      status: entry.status,
      subjects: entry.subjects.map(toPlainSubject),
    }));
}

/* ── DELETE — conservative, non-cascading removal ──────────────── */

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminStructureLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const confirm = url.searchParams.get("confirm")?.trim() || "";
    const scope = url.searchParams.get("scope")?.trim() || "";
    const subjectCode = url.searchParams.get("subjectCode")?.trim() || "";
    const semesterParam = url.searchParams.get("semesterNumber")?.trim() || "";

    // Every removal through this endpoint is PERMANENT, so the caller must say
    // so explicitly. This is what stops a stray request (or a mistyped URL) from
    // destroying curriculum: deactivation is the reversible, preferred option.
    if (confirm !== "permanent") {
      return fail(
        "Permanent deletion requires confirm=permanent. Deactivating (status=INACTIVE) is the reversible option and is preferred for curriculum that has been used."
      );
    }

    const loaded = await loadStructure({
      id: url.searchParams.get("id"),
      programmeCode: url.searchParams.get("programmeCode"),
      academicSession: url.searchParams.get("academicSession"),
    });
    if ("error" in loaded) return loaded.error;

    const structure = loaded.document;

    // ── 1. Remove ONE subject ─────────────────────────────────────
    if (subjectCode) {
      const semesterNumber = parseSemesterNumber(semesterParam);
      if (semesterNumber === null) {
        return fail("A valid semester number is required to delete a subject.");
      }

      const semester = structure.semesters.find(
        (entry) => entry.semesterNumber === semesterNumber
      );
      if (!semester) {
        return fail(`Semester ${semesterNumber} was not found in this structure.`, 404);
      }

      const target = semester.subjects.find(
        (subject) =>
          subject.subjectCode.toUpperCase() === subjectCode.toUpperCase()
      );
      if (!target) {
        return fail(
          `Subject ${subjectCode} was not found in Semester ${semesterNumber}.`,
          404
        );
      }

      // $pull removes exactly that element — every other subject, semester and
      // the structure itself are untouched. The subject's academic metadata
      // (credits, marks structure) is part of the definition and goes with it;
      // no Result or Syllabus record is touched (there is no such link yet).
      const updated = await ProgrammeStructure.findOneAndUpdate(
        { _id: structure._id, "semesters.semesterNumber": semesterNumber },
        { $pull: { "semesters.$.subjects": { subjectCode: target.subjectCode } } },
        { new: true }
      );

      if (!updated) {
        return fail(
          `Subject ${subjectCode} was not found in Semester ${semesterNumber}.`,
          404
        );
      }

      return NextResponse.json({
        success: true,
        message: `Subject ${target.subjectCode} removed from Semester ${semesterNumber}.`,
        structure: toSafeProgrammeStructure(updated),
      });
    }

    // ── 2. Remove ONE semester (with its subject definitions) ──────
    if (semesterParam) {
      const semesterNumber = parseSemesterNumber(semesterParam);
      if (semesterNumber === null) {
        return fail("Semester number must be a whole number between 1 and 12.");
      }

      const exists = structure.semesters.some(
        (entry) => entry.semesterNumber === semesterNumber
      );
      if (!exists) {
        return fail(`Semester ${semesterNumber} was not found in this structure.`, 404);
      }

      const updated = await ProgrammeStructure.findByIdAndUpdate(
        structure._id,
        { $pull: { semesters: { semesterNumber } } },
        { new: true }
      );

      return NextResponse.json({
        success: true,
        message: `Semester ${semesterNumber} removed from ${structure.programmeCode} (${structure.academicSession}).`,
        structure: updated ? toSafeProgrammeStructure(updated) : null,
      });
    }

    // ── 3. Remove the WHOLE structure ─────────────────────────────
    // Explicit `scope=structure` guard, plus the INACTIVE-first rule from
    // lib/programme-structure, means a whole curriculum can only be destroyed by
    // a deliberate, reversible-first decision.
    //
    // REFERENCE GUARD: nothing references a ProgrammeStructure yet (Phase 1 has
    // no Syllabus/Result integration), so there is no reference check to run.
    // When those phases land, their "is this structure already used?" check
    // belongs HERE, before the delete, and must never cascade into their records.
    if (scope === "structure") {
      const decision = resolveStructureDeleteDecision(structure.status);
      if (!decision.allowed) {
        return fail(decision.message, 409);
      }

      const deleted = await ProgrammeStructure.findByIdAndDelete(structure._id);

      return NextResponse.json({
        success: true,
        message: `Programme structure ${structure.programmeCode} (${structure.academicSession}) permanently deleted.`,
        notice: decision.message,
        deleted: {
          id: String(deleted?._id ?? structure._id),
          programmeCode: structure.programmeCode,
          academicSession: structure.academicSession,
        },
      });
    }

    return fail("Specify a semesterNumber, a subjectCode, or scope=structure to delete.");
  } catch (error) {
    console.error("Admin academic structure delete error:", error);
    return fail("Unable to delete programme structure data.", 500);
  }
}
