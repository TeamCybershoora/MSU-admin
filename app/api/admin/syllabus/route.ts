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
import {
  parseAttachment,
  validateSubjects,
} from "@/lib/syllabus-validation";
import { deleteSyllabusPdf, parseSyllabusPdfId } from "@/lib/pdf-storage";

const adminSyllabusLimiter = createRateLimiter({
  name: "admin-syllabus",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = url.searchParams.get("programme")?.trim() || "";
    const semester = url.searchParams.get("semester")?.trim() || "";
    const search = url.searchParams.get("search")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (programme) {
      query.programme = programme.toUpperCase();
    }

    if (semester) {
      query.semester = parseInt(semester, 10);
    }

    if (search) {
      query.$or = [
        { programme: { $regex: escapeRegex(search), $options: "i" } },
        { "subjects.subjectName": { $regex: escapeRegex(search), $options: "i" } },
        { "subjects.subjectCode": { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const [syllabi, total] = await Promise.all([
      Syllabus.find(query)
        .sort({ programme: 1, semester: 1 })
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
    return NextResponse.json(
      { success: false, message: "Unable to load syllabus records." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { programme, semester, subjects, pdfUrl, pdfName } = body;

    if (!programme || typeof programme !== "string" || !programme.trim()) {
      return NextResponse.json(
        { success: false, message: "Programme is required." },
        { status: 400 }
      );
    }

    if (!semester || typeof semester !== "number" || semester < 1 || semester > 12) {
      return NextResponse.json(
        { success: false, message: "Semester must be a number between 1 and 12." },
        { status: 400 }
      );
    }

    const subjectValidation = validateSubjects(subjects);
    if (!subjectValidation.ok) {
      return NextResponse.json(
        { success: false, message: subjectValidation.message },
        { status: 400 }
      );
    }
    const validSubjects = subjectValidation.data;

    // ── Syllabus PDF attachment ────────────────────────────────
    // `undefined` means the request did not touch the attachment, so any file
    // already on the record must be retained. `null`/"" explicitly clears it.
    // Only references issued by POST /api/admin/syllabus/upload are accepted —
    // an arbitrary URL or filesystem path can never be stored.
    const attachment = parseAttachment(pdfUrl, pdfName);
    if (!attachment.ok) {
      return NextResponse.json(
        { success: false, message: attachment.message },
        { status: 400 }
      );
    }
    const pdf = attachment.data;

    // Upsert: one syllabus per programme + semester
    const existing = await Syllabus.findOne({
      programme: programme.trim().toUpperCase(),
      semester,
    });

    if (existing) {
      const previousPdfUrl = existing.pdfUrl ?? null;

      existing.subjects = validSubjects;
      if (pdf !== undefined) {
        existing.pdfUrl = pdf.pdfUrl;
        existing.pdfName = pdf.pdfName;
      }
      await existing.save();

      // A replaced or cleared attachment leaves its old GridFS file orphaned.
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
      programme: programme.trim().toUpperCase(),
      semester,
      subjects: validSubjects,
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
      errors?: Record<string, { message: string }>;
    };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin syllabus create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to save syllabus." },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/admin/syllabus
 *
 * Partial, identifier-based update of ONE semester document. Every field is
 * optional and addressed generically by `programme` + `semester`, so the same
 * request manages BCA Semester 1 and B.Tech Semester 2:
 *
 *   { programme, semester, subjects }   → replace the whole subject list
 *   { programme, semester, subject }    → ADD one new subject, or EDIT one
 *                                         existing subject via
 *                                         `originalSubjectCode`
 *   { programme, semester, semesterNumber } → renumber the semester
 *   { programme, semester, pdfUrl, pdfName } → attach/replace/clear the
 *                                         semester-level PDF attachment
 *
 * Rules:
 * - `subjects` and `subject` are mutually exclusive (ambiguous combination).
 * - The subject operation is chosen by the REQUEST, never by looking the new
 *   code up:
 *       `originalSubjectCode` present → edit that existing subject (404 if
 *                                       it is not in this semester)
 *       `originalSubjectCode` absent  → add a brand-new subject (accepted
 *                                       even though the code does not yet
 *                                       exist; a duplicate code is 409)
 * - An edit touches only the targeted subject: unrelated subjects, other
 *   semesters and the programme-level ProgrammeSyllabus record are untouched.
 * - The semester PDF keeps POST's "undefined = leave untouched" semantics.
 *
 * Responses mirror POST: { success, message, syllabus }.
 */
export async function PATCH(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!body) {
      return NextResponse.json(
        { success: false, message: "Invalid request body." },
        { status: 400 }
      );
    }

    const programme = parseProgrammeCode(body.programme);
    if (!programme) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Programme is required (1-20 characters: letters, spaces, dots, ampersands or hyphens).",
        },
        { status: 400 }
      );
    }

    const semester = parseSemesterNumber(body.semester);
    if (semester === null) {
      return NextResponse.json(
        { success: false, message: "Semester must be a number between 1 and 12." },
        { status: 400 }
      );
    }

    if (body.subjects !== undefined && body.subject !== undefined) {
      return NextResponse.json(
        {
          success: false,
          message: "Provide either subjects or subject, not both.",
        },
        { status: 400 }
      );
    }

    const syllabus = await Syllabus.findOne({ programme, semester });

    if (!syllabus) {
      return NextResponse.json(
        {
          success: false,
          message: `No syllabus found for ${programme} Semester ${semester}.`,
        },
        { status: 404 }
      );
    }

    const touched: string[] = [];

    // ── Add OR edit ONE subject ────────────────────────────────
    // The operation is selected by the request, never by looking the submitted
    // code up in the existing subjects:
    //   originalSubjectCode present → EDIT that subject (it must exist)
    //   originalSubjectCode absent  → ADD a brand-new subject (it need not
    //                                 exist; only a duplicate code is rejected)
    if (body.subject !== undefined) {
      const subjectValidation = validateSubjects([body.subject]);
      if (!subjectValidation.ok) {
        return NextResponse.json(
          { success: false, message: subjectValidation.message },
          { status: 400 }
        );
      }

      const nextSubject = subjectValidation.data[0];
      const rawSubject = body.subject as Record<string, unknown>;
      const originalCode =
        typeof rawSubject.originalSubjectCode === "string" &&
        rawSubject.originalSubjectCode.trim()
          ? rawSubject.originalSubjectCode.trim()
          : "";

      // Only an edit names an existing subject; an add leaves this empty, so
      // no existing-subject lookup is required to add.
      const index = originalCode
        ? syllabus.subjects.findIndex(
            (s: ISyllabusSubject) =>
              s.subjectCode.toLowerCase() === originalCode.toLowerCase()
          )
        : -1;

      if (originalCode && index === -1) {
        return NextResponse.json(
          {
            success: false,
            message: `Subject ${originalCode} was not found in ${programme} Semester ${semester}.`,
          },
          { status: 404 }
        );
      }

      // A code may not collide with another subject in this semester: on an
      // add that is every subject, on an edit every OTHER subject.
      const duplicate = syllabus.subjects.some(
        (s: ISyllabusSubject, i: number) =>
          i !== index &&
          s.subjectCode.toLowerCase() === nextSubject.subjectCode.toLowerCase()
      );

      if (duplicate) {
        return NextResponse.json(
          {
            success: false,
            message: `Subject code ${nextSubject.subjectCode} already exists in ${programme} Semester ${semester}.`,
          },
          { status: 409 }
        );
      }

      if (index === -1) {
        // ADD: append the new subject; every existing subject is left as-is.
        syllabus.subjects.push(nextSubject);
      } else {
        // EDIT: replace exactly one array slot — every other subject is left
        // as-is.
        syllabus.subjects.splice(index, 1, nextSubject);
      }
      touched.push("subject");
    }

    // ── Replace the whole subject list ─────────────────────────
    if (body.subjects !== undefined) {
      const subjectValidation = validateSubjects(body.subjects);
      if (!subjectValidation.ok) {
        return NextResponse.json(
          { success: false, message: subjectValidation.message },
          { status: 400 }
        );
      }

      syllabus.subjects = subjectValidation.data;
      touched.push("subjects");
    }

    // ── Renumber the semester ──────────────────────────────────
    if (body.semesterNumber !== undefined) {
      const newSemester = parseSemesterNumber(body.semesterNumber);
      if (newSemester === null) {
        return NextResponse.json(
          {
            success: false,
            message: "Semester number must be between 1 and 12.",
          },
          { status: 400 }
        );
      }

      if (newSemester !== semester) {
        const clash = await Syllabus.exists({ programme, semester: newSemester });
        if (clash) {
          return NextResponse.json(
            {
              success: false,
              message: `Semester ${newSemester} already exists for ${programme}.`,
            },
            { status: 409 }
          );
        }

        syllabus.semester = newSemester;
        touched.push("semester");
      }
    }

    // ── Attach / replace / clear the semester PDF ──────────────
    const attachment = parseAttachment(body.pdfUrl, body.pdfName);
    if (!attachment.ok) {
      return NextResponse.json(
        { success: false, message: attachment.message },
        { status: 400 }
      );
    }

    const previousPdfUrl = syllabus.pdfUrl ?? null;

    if (attachment.data !== undefined) {
      syllabus.pdfUrl = attachment.data.pdfUrl;
      syllabus.pdfName = attachment.data.pdfName;
      touched.push("pdf");
    }

    if (touched.length === 0) {
      return NextResponse.json(
        { success: false, message: "No supported fields to update." },
        { status: 400 }
      );
    }

    await syllabus.save();

    // The new reference is already persisted, so the superseded bytes can now
    // be removed without ever leaving a broken reference behind.
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
      return NextResponse.json(
        {
          success: false,
          message: "A syllabus for that programme and semester already exists.",
        },
        { status: 409 }
      );
    }

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin syllabus update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update syllabus." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/syllabus
 *
 * One generic, identifier-based endpoint for every level of the structured
 * syllabus. The scope is chosen by which identifiers are present — never by a
 * programme, semester or subject name in the path:
 *
 *   ?programme=BCA&semester=1&subjectCode=BCA-101 → remove ONE subject only
 *   ?programme=BCA&semester=1                     → remove ONE semester
 *   ?programme=BCA&scope=programme                → remove the COMPLETE
 *                                                   structured syllabus of a
 *                                                   programme (all semesters)
 *
 * What is deliberately NOT touched:
 * - the programme-level official PDF (ProgrammeSyllabus is a separate
 *   collection and is never read, written or deleted here),
 * - any other programme,
 * - for a subject delete, any other subject or the semester itself,
 * - for a semester delete, any other semester of the programme.
 *
 * Semester PDFs that belong to removed documents are cleaned from GridFS only
 * AFTER the database references are gone, so no broken reference can remain.
 */
export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminSyllabusLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);
    const programme = parseProgrammeCode(url.searchParams.get("programme"));

    if (!programme) {
      return NextResponse.json(
        { success: false, message: "A valid programme is required." },
        { status: 400 }
      );
    }

    const subjectCode = url.searchParams.get("subjectCode")?.trim() || "";
    const semesterParam = url.searchParams.get("semester")?.trim() || "";
    const scope = url.searchParams.get("scope")?.trim() || "";

    // ── 1. Delete ONE subject (must name its semester) ─────────
    if (subjectCode) {
      const semester = parseSemesterNumber(semesterParam);
      if (semester === null) {
        return NextResponse.json(
          {
            success: false,
            message: "A valid semester is required to delete a subject.",
          },
          { status: 400 }
        );
      }

      const existing = await Syllabus.findOne({ programme, semester });

      if (!existing) {
        return NextResponse.json(
          {
            success: false,
            message: `No syllabus found for ${programme} Semester ${semester}.`,
          },
          { status: 404 }
        );
      }

      // Case-insensitive lookup, so a code typed in another case still matches
      // the subject the admin was looking at. The removal itself then uses the
      // EXACT stored code, and an atomic $pull, so only that one element leaves
      // the array — every other subject is untouched.
      const target = existing.subjects.find(
        (s: ISyllabusSubject) =>
          s.subjectCode.toLowerCase() === subjectCode.toLowerCase()
      );

      if (!target) {
        return NextResponse.json(
          {
            success: false,
            message: `Subject ${subjectCode} was not found in ${programme} Semester ${semester}.`,
          },
          { status: 404 }
        );
      }

      const updated = await Syllabus.findOneAndUpdate(
        { programme, semester },
        { $pull: { subjects: { subjectCode: target.subjectCode } } },
        { new: true }
      );

      if (!updated) {
        return NextResponse.json(
          {
            success: false,
            message: `Subject ${subjectCode} was not found in ${programme} Semester ${semester}.`,
          },
          { status: 404 }
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
        return NextResponse.json(
          {
            success: false,
            message: "Semester must be a number between 1 and 12.",
          },
          { status: 400 }
        );
      }

      const deleted = await Syllabus.findOneAndDelete({ programme, semester });

      if (!deleted) {
        return NextResponse.json(
          {
            success: false,
            message: `No syllabus found for ${programme} Semester ${semester}.`,
          },
          { status: 404 }
        );
      }

      const removedPdfId = deleted.pdfUrl
        ? parseSyllabusPdfId(deleted.pdfUrl)
        : null;
      if (removedPdfId) await deleteSyllabusPdf(removedPdfId);

      return NextResponse.json({
        success: true,
        message: `${programme} Semester ${semester} removed.`,
        deleted: { programme, semester },
      });
    }

    // ── 3. Delete the COMPLETE structured syllabus of a programme ──
    // The explicit `scope=programme` guard means a bare DELETE can never wipe
    // a whole programme by accident.
    if (scope === "programme") {
      const docs = await Syllabus.find({ programme }).select("pdfUrl").lean();
      const result = await Syllabus.deleteMany({ programme });

      for (const doc of docs) {
        const staleId = doc.pdfUrl ? parseSyllabusPdfId(doc.pdfUrl) : null;
        if (staleId) await deleteSyllabusPdf(staleId);
      }

      const deletedCount = result.deletedCount ?? 0;

      return NextResponse.json({
        success: true,
        message:
          deletedCount === 0
            ? `No structured syllabus records existed for ${programme}.`
            : `Complete ${programme} structured syllabus removed (${deletedCount} semester(s)).`,
        deletedCount,
      });
    }

    return NextResponse.json(
      {
        success: false,
        message: "Specify a semester, a subjectCode, or scope=programme.",
      },
      { status: 400 }
    );
  } catch (error) {
    console.error("Admin syllabus delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete syllabus." },
      { status: 500 }
    );
  }
}
