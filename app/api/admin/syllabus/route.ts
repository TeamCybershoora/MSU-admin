import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Syllabus, {
  toSafeSyllabus,
  type ISyllabusSubject,
} from "@/models/Syllabus";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  escapeRegex,
  parseProgrammeCode,
  parseSemesterNumber,
} from "@/lib/validation";
import { parseAcademicSession } from "@/lib/programme-structure";
import {
  parseAttachment,
  validateSubjectRefs,
  type SyllabusSubjectRef,
} from "@/lib/syllabus-validation";
import {
  resolveSemester,
  resolveStructure,
  resolveSubject,
  type AcademicStructureSnapshot,
} from "@/lib/syllabus-academic";
import { deleteSyllabusPdf, parseSyllabusPdfId } from "@/lib/pdf-storage";

/**
 * /api/admin/syllabus — structured syllabus documents (Phase 2A).
 *
 * OWNERSHIP: ProgrammeStructure is the single source of truth for academic
 * metadata. This route only stores DOCUMENT associations and validates their
 * academic identity against ProgrammeStructure before anything is written.
 *
 *   Identity:  programmeCode + academicSession + semesterNumber
 *   Subject:   + subjectCode (the subject NAME is read from the structure)
 *
 *   GET    list (filters: programme, academicSession, semester, search)
 *   POST   create/upsert a semester document (identity + semester PDF + subjects)
 *   PATCH  update ONE semester: renumber · attach/replace/clear PDF ·
 *          add/edit ONE subject · replace the subject list
 *   DELETE remove ONE subject · ONE semester · the structured syllabus of an
 *          identity (scope=programme)
 *
 * SERVER AUTHORITY: a subject is addressed by its CODE and its metadata is read
 * from ProgrammeStructure — a client-sent `subjectName` (or credits/assessment)
 * is never trusted. Attaching a NEW document requires the programme, semester
 * and subject to be effectively ACTIVE; removing/clearing an existing document
 * is always allowed, so a historical record stays maintainable and nothing is
 * ever deleted automatically when a structure is deactivated.
 *
 * LEGACY: documents written before this integration carry no academicSession.
 * They are never attributed to a session here; DELETE addresses them with the
 * session omitted (the session-less record), and any unmapped legacy record is
 * reported rather than guessed.
 */

const adminSyllabusLimiter = createRateLimiter({
  name: "admin-syllabus",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

/**
 * Turn submitted subject references into stored subjects, reading the
 * authoritative name from the structure. A reference to a subject the structure
 * does not define (or an inactive one) is rejected, so the document layer can
 * never invent or contradict curriculum.
 */
function buildStoredSubjects(
  structure: AcademicStructureSnapshot,
  semesterNumber: number,
  refs: SyllabusSubjectRef[]
): { ok: true; data: ISyllabusSubject[] } | { ok: false; message: string } {
  const subjects: ISyllabusSubject[] = [];

  for (const ref of refs) {
    const resolved = resolveSubject(structure, semesterNumber, ref.subjectCode, {
      requireActive: true,
    });
    if (!resolved.ok) return { ok: false, message: resolved.message };

    subjects.push({
      subjectCode: resolved.data.subject.subjectCode,
      // Denormalized display snapshot — always the structure's value.
      subjectName: resolved.data.subject.subjectName,
      syllabusUrl: ref.syllabusUrl,
      pdfUrl: ref.pdfUrl,
    });
  }

  return { ok: true, data: subjects };
}

/** True when the body attaches a NEW/replacement PDF (null/"" = clearing). */
function attachesPdf(rawPdfUrl: unknown): boolean {
  return typeof rawPdfUrl === "string" && rawPdfUrl.trim() !== "";
}

/**
 * Explain a duplicate-key error on create.
 *
 * A database that still carries the pre-integration `{ programme, semester }`
 * unique index rejects a second (session-scoped) document for the same
 * programme + semester because a LEGACY session-less record occupies it. That is
 * reported honestly — the legacy record is never mapped to a session
 * automatically.
 */
async function duplicateIdentityResponse(
  context: { programme: string; semester: number } | null
): Promise<NextResponse> {
  if (context) {
    try {
      const legacy = await Syllabus.findOne({
        programme: context.programme,
        semester: context.semester,
        academicSession: null,
      }).select("_id");

      if (legacy) {
        return fail(
          `A legacy session-less syllabus record already exists for ${context.programme} Semester ${context.semester}. It cannot be mapped to an academic session automatically — a migration must be performed first (no session is ever guessed).`,
          409
        );
      }
    } catch {
      /* legacy collection absent — fall through to the generic message */
    }
  }

  return fail(
    "A syllabus document already exists for that programme, academic session and semester.",
    409
  );
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = url.searchParams.get("programme")?.trim() || "";
    const academicSession = url.searchParams.get("academicSession")?.trim() || "";
    const semester = url.searchParams.get("semester")?.trim() || "";
    const search = url.searchParams.get("search")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (programme) {
      query.programme = programme.toUpperCase();
    }

    if (academicSession) {
      query.academicSession = academicSession;
    }

    if (semester) {
      query.semester = parseInt(semester, 10);
    }

    if (search) {
      query.$or = [
        { programme: { $regex: escapeRegex(search), $options: "i" } },
        { academicSession: { $regex: escapeRegex(search), $options: "i" } },
        { "subjects.subjectName": { $regex: escapeRegex(search), $options: "i" } },
        { "subjects.subjectCode": { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const [syllabi, total] = await Promise.all([
      Syllabus.find(query)
        .sort({ programme: 1, academicSession: 1, semester: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Syllabus.countDocuments(query),
    ]);

    const programmes = await Syllabus.distinct("programme");

    return NextResponse.json({
      success: true,
      data: syllabi.map((s) => ({
        id: s._id,
        programme: s.programme,
        academicSession: s.academicSession ?? null,
        semester: s.semester,
        subjects: s.subjects,
        subjectCount: s.subjects.length,
        pdfUrl: s.pdfUrl ?? null,
        pdfName: s.pdfName ?? null,
        createdAt: s.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      filters: {
        programmes: programmes.sort(),
      },
    });
  } catch (error) {
    console.error("Admin syllabus list error:", error);
    return fail("Unable to load syllabus records.", 500);
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  // Captured for a precise duplicate-key message (see duplicateIdentityResponse).
  let conflictContext: { programme: string; semester: number } | null = null;

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    // ── Academic identity ──────────────────────────────────────
    // The structure must exist and be ACTIVE: a new document is never attached
    // to an inactive (historical) curriculum.
    const resolved = await resolveStructure(
      body.programme,
      body.academicSession,
      { requireActive: true }
    );
    if (!resolved.ok) return fail(resolved.message, resolved.status);

    const { programmeCode, academicSession, structure } = resolved.data;

    const semesterResult = resolveSemester(structure, body.semester, {
      requireActive: true,
    });
    if (!semesterResult.ok) return fail(semesterResult.message, semesterResult.status);
    const semester = semesterResult.data.semesterNumber;

    conflictContext = { programme: programmeCode, semester };

    // ── Subject references (optional) ──────────────────────────
    // undefined = leave the existing subject list untouched on an upsert.
    let nextSubjects: ISyllabusSubject[] | undefined;
    if (body.subjects !== undefined) {
      const refs = validateSubjectRefs(body.subjects);
      if (!refs.ok) return fail(refs.message);

      const built = buildStoredSubjects(structure, semester, refs.data);
      if (!built.ok) return fail(built.message);
      nextSubjects = built.data;
    }

    // ── Semester PDF attachment ────────────────────────────────
    // `undefined` leaves the attachment untouched; `null`/"" clears it; a
    // string must be a reference this server issued.
    const attachment = parseAttachment(body.pdfUrl, body.pdfName);
    if (!attachment.ok) return fail(attachment.message);
    const pdf = attachment.data;

    const existing = await Syllabus.findOne({
      programme: programmeCode,
      academicSession,
      semester,
    });

    if (existing) {
      if (nextSubjects !== undefined) existing.subjects = nextSubjects;

      const previousPdfUrl = existing.pdfUrl ?? null;
      if (pdf !== undefined) {
        existing.pdfUrl = pdf.pdfUrl;
        existing.pdfName = pdf.pdfName;
      }
      await existing.save();

      if (pdf !== undefined && previousPdfUrl && previousPdfUrl !== pdf.pdfUrl) {
        const staleId = parseSyllabusPdfId(previousPdfUrl);
        if (staleId) await deleteSyllabusPdf(staleId);
      }

      return NextResponse.json({
        success: true,
        message: "Syllabus updated successfully.",
        syllabus: toSafeSyllabus(existing),
      });
    }

    const syllabus = await Syllabus.create({
      programme: programmeCode,
      academicSession,
      semester,
      subjects: nextSubjects ?? [],
      pdfUrl: pdf?.pdfUrl ?? null,
      pdfName: pdf?.pdfName ?? null,
    });

    return NextResponse.json({
      success: true,
      message: "Syllabus created successfully.",
      syllabus: toSafeSyllabus(syllabus),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      return duplicateIdentityResponse(conflictContext);
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return fail(messages.join(" "));
    }

    console.error("Admin syllabus create error:", error);
    return fail("Unable to save syllabus.", 500);
  }
}

/**
 * PATCH /api/admin/syllabus
 *
 * Partial, identifier-based update of ONE semester document, addressed by
 * programme + academicSession + semester:
 *
 *   { …, subjects }                       → replace the whole subject list
 *   { …, subject }                        → ADD one subject (originalSubjectCode
 *                                           absent) or EDIT one (present)
 *   { …, semesterNumber }                 → renumber the semester
 *   { …, pdfUrl, pdfName }                → attach/replace/clear the semester PDF
 *
 * Subject names are read from ProgrammeStructure; any client-sent name is
 * ignored. Attaching subjects or a PDF requires an ACTIVE structure/semester;
 * renumbering or clearing a PDF does not.
 */
export async function PATCH(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return fail("Invalid request body.");

    // Attaching a document (new subject / attachment) needs an ACTIVE
    // structure; renumbering or clearing a reference does not.
    const needsActive =
      body.subject !== undefined ||
      body.subjects !== undefined ||
      attachesPdf(body.pdfUrl);

    const resolved = await resolveStructure(
      body.programme,
      body.academicSession,
      { requireActive: needsActive }
    );
    if (!resolved.ok) return fail(resolved.message, resolved.status);

    const { programmeCode, academicSession, structure } = resolved.data;

    const semesterResult = resolveSemester(structure, body.semester, {
      requireActive: needsActive,
    });
    if (!semesterResult.ok) return fail(semesterResult.message, semesterResult.status);
    const semester = semesterResult.data.semesterNumber;

    if (body.subjects !== undefined && body.subject !== undefined) {
      return fail("Provide either subjects or subject, not both.");
    }

    const syllabus = await Syllabus.findOne({
      programme: programmeCode,
      academicSession,
      semester,
    });

    if (!syllabus) {
      return fail(
        `No syllabus document found for ${programmeCode} (${academicSession}) Semester ${semester}.`,
        404
      );
    }

    const touched: string[] = [];

    // ── Add OR edit ONE subject ────────────────────────────────
    if (body.subject !== undefined) {
      const rawSubject = body.subject as Record<string, unknown>;
      const refs = validateSubjectRefs([rawSubject]);
      if (!refs.ok) return fail(refs.message);

      const built = buildStoredSubjects(structure, semester, refs.data);
      if (!built.ok) return fail(built.message);
      const nextSubject = built.data[0];

      const originalCode =
        typeof rawSubject.originalSubjectCode === "string" &&
        rawSubject.originalSubjectCode.trim()
          ? rawSubject.originalSubjectCode.trim()
          : "";

      const index = originalCode
        ? syllabus.subjects.findIndex(
            (s: ISyllabusSubject) =>
              s.subjectCode.toLowerCase() === originalCode.toLowerCase()
          )
        : -1;

      if (originalCode && index === -1) {
        return fail(
          `Subject ${originalCode} was not found in ${programmeCode} (${academicSession}) Semester ${semester}.`,
          404
        );
      }

      const duplicate = syllabus.subjects.some(
        (s: ISyllabusSubject, i: number) =>
          i !== index &&
          s.subjectCode.toLowerCase() === nextSubject.subjectCode.toLowerCase()
      );

      if (duplicate) {
        return fail(
          `Subject ${nextSubject.subjectCode} already exists in this semester.`,
          409
        );
      }

      if (index === -1) {
        syllabus.subjects.push(nextSubject);
      } else {
        syllabus.subjects.splice(index, 1, nextSubject);
      }
      touched.push("subject");
    }

    // ── Replace the whole subject list ─────────────────────────
    if (body.subjects !== undefined) {
      const refs = validateSubjectRefs(body.subjects);
      if (!refs.ok) return fail(refs.message);

      const built = buildStoredSubjects(structure, semester, refs.data);
      if (!built.ok) return fail(built.message);

      syllabus.subjects = built.data;
      touched.push("subjects");
    }

    // ── Renumber the semester (kept inside its own structure/session) ──
    if (body.semesterNumber !== undefined) {
      const newSemester = parseSemesterNumber(body.semesterNumber);
      if (newSemester === null) {
        return fail("Semester number must be between 1 and 12.");
      }

      if (newSemester !== semester) {
        // The target must exist in the structure — a syllabus document can
        // never introduce a semester the curriculum does not define.
        const target = resolveSemester(structure, newSemester);
        if (!target.ok) return fail(target.message, target.status);

        const clash = await Syllabus.exists({
          programme: programmeCode,
          academicSession,
          semester: newSemester,
        });
        if (clash) {
          return fail(
            `Semester ${newSemester} already has a syllabus document for ${programmeCode} (${academicSession}).`,
            409
          );
        }

        syllabus.semester = newSemester;
        touched.push("semester");
      }
    }

    // ── Attach / replace / clear the semester PDF ──────────────
    const attachment = parseAttachment(body.pdfUrl, body.pdfName);
    if (!attachment.ok) return fail(attachment.message);

    const previousPdfUrl = syllabus.pdfUrl ?? null;

    if (attachment.data !== undefined) {
      syllabus.pdfUrl = attachment.data.pdfUrl;
      syllabus.pdfName = attachment.data.pdfName;
      touched.push("pdf");
    }

    if (touched.length === 0) {
      return fail("No supported fields to update.");
    }

    await syllabus.save();

    if (
      attachment.data !== undefined &&
      previousPdfUrl &&
      previousPdfUrl !== attachment.data.pdfUrl
    ) {
      const staleId = parseSyllabusPdfId(previousPdfUrl);
      if (staleId) await deleteSyllabusPdf(staleId);
    }

    return NextResponse.json({
      success: true,
      message: "Syllabus updated successfully.",
      syllabus: toSafeSyllabus(syllabus),
    });
  } catch (error: unknown) {
    const err = error as {
      name?: string;
      code?: number;
      errors?: Record<string, { message: string }>;
    };

    if (err.code === 11000) {
      return fail(
        "A syllabus document already exists for that programme, academic session and semester.",
        409
      );
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return fail(messages.join(" "));
    }

    console.error("Admin syllabus update error:", error);
    return fail("Unable to update syllabus.", 500);
  }
}

/**
 * DELETE /api/admin/syllabus
 *
 *   ?programme=BCA&academicSession=2023-24&semester=1&subjectCode=0127001 → one subject
 *   ?programme=BCA&academicSession=2023-24&semester=1                     → one semester
 *   ?programme=BCA&academicSession=2023-24&scope=programme                → its structured syllabus
 *
 * Omitting `academicSession` targets a LEGACY session-less record (never a
 * guessed session). Deletion never touches the official programme PDF, any other
 * structure/session, or the academic structure itself; a semester/subject PDF in
 * GridFS is cleaned only AFTER the database reference is gone.
 */
export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return fail("Too many requests. Please try again later.", 429);
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = parseProgrammeCode(url.searchParams.get("programme"));
    if (!programme) return fail("A valid programme is required.");

    const rawSession = url.searchParams.get("academicSession");
    const sessionProvided =
      rawSession !== null && rawSession.trim() !== "";
    const academicSession = sessionProvided ? parseAcademicSession(rawSession) : null;
    if (sessionProvided && !academicSession) {
      return fail("Academic session must look like 2023-24.");
    }

    const subjectCode = url.searchParams.get("subjectCode")?.trim() || "";
    const semesterParam = url.searchParams.get("semester")?.trim() || "";
    const scope = url.searchParams.get("scope")?.trim() || "";

    // Legacy records are addressed with the session omitted (null).
    const identityQuery: Record<string, unknown> = {
      programme,
      academicSession: academicSession ?? null,
    };

    // ── 1. Delete ONE subject ──────────────────────────────────
    if (subjectCode) {
      const semester = parseSemesterNumber(semesterParam);
      if (semester === null) {
        return fail("A valid semester is required to delete a subject.");
      }

      const existing = await Syllabus.findOne({ ...identityQuery, semester });
      if (!existing) {
        return fail(
          `No syllabus document found for ${programme} (${academicSession ?? "legacy"}) Semester ${semester}.`,
          404
        );
      }

      const target = existing.subjects.find(
        (s: ISyllabusSubject) =>
          s.subjectCode.toLowerCase() === subjectCode.toLowerCase()
      );
      if (!target) {
        return fail(
          `Subject ${subjectCode} was not found in ${programme} Semester ${semester}.`,
          404
        );
      }

      const updated = await Syllabus.findOneAndUpdate(
        { ...identityQuery, semester },
        { $pull: { subjects: { subjectCode: target.subjectCode } } },
        { new: true }
      );

      if (!updated) {
        return fail(
          `Subject ${subjectCode} was not found in ${programme} Semester ${semester}.`,
          404
        );
      }

      return NextResponse.json({
        success: true,
        message: `Subject ${subjectCode} removed from ${programme} Semester ${semester}.`,
        syllabus: toSafeSyllabus(updated),
      });
    }

    // ── 2. Delete ONE semester document ────────────────────────
    if (semesterParam) {
      const semester = parseSemesterNumber(semesterParam);
      if (semester === null) {
        return fail("Semester must be a number between 1 and 12.");
      }

      const deleted = await Syllabus.findOneAndDelete({
        ...identityQuery,
        semester,
      });
      if (!deleted) {
        return fail(
          `No syllabus document found for ${programme} (${academicSession ?? "legacy"}) Semester ${semester}.`,
          404
        );
      }

      const removedPdfId = deleted.pdfUrl
        ? parseSyllabusPdfId(deleted.pdfUrl)
        : null;
      if (removedPdfId) await deleteSyllabusPdf(removedPdfId);

      return NextResponse.json({
        success: true,
        message: `${programme} Semester ${semester} removed.`,
        deleted: { programme, academicSession: academicSession ?? null, semester },
      });
    }

    // ── 3. Delete the structured syllabus of ONE identity ──────
    if (scope === "programme") {
      const docs = await Syllabus.find(identityQuery).select("pdfUrl").lean();
      const result = await Syllabus.deleteMany(identityQuery);

      for (const doc of docs) {
        const staleId = doc.pdfUrl ? parseSyllabusPdfId(doc.pdfUrl) : null;
        if (staleId) await deleteSyllabusPdf(staleId);
      }

      const deletedCount = result.deletedCount ?? 0;

      return NextResponse.json({
        success: true,
        message:
          deletedCount === 0
            ? `No structured syllabus records existed for ${programme} (${academicSession ?? "legacy"}).`
            : `Complete ${programme} (${academicSession ?? "legacy"}) structured syllabus removed (${deletedCount} semester(s)).`,
        deletedCount,
      });
    }

    return fail("Specify a semester, a subjectCode, or scope=programme.");
  } catch (error) {
    console.error("Admin syllabus delete error:", error);
    return fail("Unable to delete syllabus.", 500);
  }
}
