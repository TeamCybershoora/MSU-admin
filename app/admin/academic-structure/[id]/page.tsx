"use client";

/**
 * Academic Structure — MANAGE one programme structure.
 *
 * The drill-down below the list page:
 *
 *   BCA → 2025-26 → [ Semester I, Semester II, … ] → [ subjects ]
 *
 * Header    : programme code + name, academic session, status, counts
 * Semesters : one card each (number, name, subject count, status) with
 *             [Edit Semester] [Delete Semester] [Add Subject]
 * Subjects  : inside each card, the dense table on desktop / record cards on
 *             phones, with [Edit] [Delete] per subject
 *
 * STATUS BEHAVIOUR SHOWN HERE (see lib/programme-structure):
 *   structure INACTIVE → the whole structure is unavailable for new selection
 *   semester  INACTIVE → its subjects are effectively unavailable
 *   subject   INACTIVE → only that subject (with its credits and marks
 *                        structure) is unavailable
 * Nothing is cascaded: deactivating a parent leaves every child record exactly
 * as it was, so reactivating restores the previous state.
 *
 * DELETION: subject/semester/structure removals are permanent and always
 * confirmed here and again server-side. Deleting a semester or subject removes
 * only that definition — no Result or Syllabus record is touched (those
 * integrations do not exist in this phase), and the structure itself requires
 * INACTIVE status before it can be deleted at all.
 */

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Layers,
  Pencil,
  Plus,
  Power,
  PowerOff,
} from "lucide-react";
import Badge from "@/components/ui/badge";
import Button from "@/components/ui/button";
import Card, { CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/modal";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import ProgrammeStructureForm, {
  type ProgrammeStructureFormValues,
} from "@/components/academic-structure/programme-structure-form";
import SemesterForm, {
  type SemesterFormValues,
} from "@/components/academic-structure/semester-form";
import SubjectForm, {
  type SubjectFormValues,
} from "@/components/academic-structure/subject-form";
import SemesterCard from "@/components/academic-structure/semester-card";
import {
  deleteSemester,
  deleteSubject,
  fetchProgrammeStructure,
  saveSemester,
  saveSubject,
  updateProgrammeStructure,
  type ApiOutcome,
} from "@/components/academic-structure/academic-structure-api";
import {
  semesterLabel,
  statusBadgeVariant,
  type CurriculumSemester,
  type CurriculumSubject,
  type ProgrammeStructureRecord,
} from "@/components/academic-structure/types";
import styles from "../page.module.css";

/** A destructive action awaiting confirmation (one dialog serves every level). */
interface PendingDelete {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

export default function ManageProgrammeStructurePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const structureId = params?.id ?? "";

  const [structure, setStructure] = useState<ProgrammeStructureRecord | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [programmeFormOpen, setProgrammeFormOpen] = useState(false);
  const [semesterForm, setSemesterForm] = useState<{
    semester: CurriculumSemester | null;
  } | null>(null);
  const [subjectForm, setSubjectForm] = useState<{
    semester: CurriculumSemester;
    subject: CurriculumSubject | null;
  } | null>(null);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [toggling, setToggling] = useState(false);

  /**
   * Load the structure. `silent` re-reads after a mutation without replacing
   * the whole page with the loading state, so editing a subject does not flash
   * the entire curriculum away and back.
   */
  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!structureId) return;
    if (!options?.silent) setLoading(true);
    setError("");
    try {
      const record = await fetchProgrammeStructure(structureId);
      if (!record) {
        setError("This programme structure could not be found.");
        setStructure(null);
        return;
      }
      setStructure(record);
    } finally {
      setLoading(false);
    }
  }, [structureId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  function flashSuccess(message: string) {
    setActionError("");
    setActionSuccess(message);
    window.setTimeout(() => setActionSuccess(""), 4000);
  }

  /* ── Programme level ───────────────────────────────────────── */

  async function handleProgrammeSave(
    values: ProgrammeStructureFormValues
  ): Promise<ApiOutcome> {      const outcome = await updateProgrammeStructure(structureId, {
        programmeName: values.programmeName,
        status: values.status,
      });

      if (outcome.success) {
        setProgrammeFormOpen(false);
        await load({ silent: true });
      flashSuccess("Programme structure updated.");
    }
    return outcome;
  }

  async function handleToggleStatus() {
    if (!structure || toggling) return;
    setToggling(true);
    setActionError("");

    const nextStatus = structure.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      const outcome = await updateProgrammeStructure(structureId, {
        status: nextStatus,
      });

      if (!outcome.success) {
        setActionSuccess("");
        setActionError(outcome.message);
        return;
      }

      await load({ silent: true });
      flashSuccess(
        nextStatus === "INACTIVE"
          ? "Structure deactivated — every semester and subject is now effectively unavailable for new selection, and no subject record was changed."
          : "Structure reactivated — its stored semester and subject statuses apply again."
      );
    } finally {
      setToggling(false);
    }
  }

  /* ── Semester level ────────────────────────────────────────── */

  async function handleSemesterSave(
    values: SemesterFormValues
  ): Promise<ApiOutcome> {
    const target = semesterForm;
    if (!target) return { success: false, message: "No semester selected." };

    const outcome = await saveSemester(
      structureId,
      values,
      target.semester ? target.semester.semesterNumber : undefined
    );

    if (outcome.success) {
      const wasEdit = !!target.semester;
      setSemesterForm(null);
      await load({ silent: true });
      flashSuccess(wasEdit ? "Semester updated." : "Semester added.");
    }
    return outcome;
  }

  /* ── Subject level ─────────────────────────────────────────── */

  async function handleSubjectSave(values: SubjectFormValues): Promise<ApiOutcome> {
    const target = subjectForm;
    if (!target) return { success: false, message: "No subject selected." };

    const outcome = await saveSubject(
      structureId,
      target.semester.semesterNumber,
      values,
      target.subject?.subjectCode
    );

    if (outcome.success) {
      const wasEdit = !!target.subject;
      setSubjectForm(null);
      await load({ silent: true });
      flashSuccess(wasEdit ? "Subject updated." : "Subject added.");
    }
    return outcome;
  }

  /* ── Deletions (each states exactly what is and is not removed) ── */

  function confirmDeleteSubject(
    semester: CurriculumSemester,
    subject: CurriculumSubject
  ) {
    setPendingDelete({
      title: `Delete ${subject.subjectCode} from ${semesterLabel(semester)}?`,
      description: `This permanently removes the subject definition "${subject.subjectCode} — ${subject.subjectName}" (credits and assessment structure included) from this curriculum. Other subjects, the semester and the rest of the structure are NOT affected, and no Result or Syllabus record is deleted. To keep the definition for reference instead, edit it and set its status to INACTIVE.`,
      confirmLabel: "Delete Subject",
      action: async () => {
        const outcome = await deleteSubject(
          structureId,
          semester.semesterNumber,
          subject.subjectCode
        );
        if (outcome.success) {
          await load({ silent: true });
          flashSuccess(outcome.message);
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  function confirmDeleteSemester(semester: CurriculumSemester) {
    const count = semester.subjects?.length ?? 0;
    setPendingDelete({
      title: `Delete ${semesterLabel(semester)}?`,
      description: `This permanently removes the semester and its ${count} subject definition(s) from this curriculum. Other semesters and the programme structure itself are NOT affected, and no Result or Syllabus record is deleted. To keep them for reference instead, edit the semester and set its status to INACTIVE.`,
      confirmLabel: "Delete Semester",
      action: async () => {
        const outcome = await deleteSemester(
          structureId,
          semester.semesterNumber
        );
        if (outcome.success) {
          await load({ silent: true });
          flashSuccess(outcome.message);
        } else {
          setActionSuccess("");
          setActionError(outcome.message);
        }
      },
    });
  }

  async function runPendingDelete() {
    const pending = pendingDelete;
    if (!pending) return;

    setDeleteLoading(true);
    setActionError("");
    try {
      await pending.action();
    } finally {
      setDeleteLoading(false);
      setPendingDelete(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.page}>
        <Card className={styles.section}>
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading programme structure...</p>
          </div>
        </Card>
      </div>
    );
  }

  if (error || !structure) {
    return (
      <div className={styles.page}>
        <Card className={styles.section}>
          <ErrorState
            title="Unable to load programme structure"
            description={error || "This programme structure could not be found."}
            onRetry={() => load()}
          />
          <div className={styles.modalActions}>
            <Button
              variant="secondary"
              onClick={() => router.push("/admin/academic-structure")}
            >
              <ArrowLeft size={14} /> Back to list
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const isActive = structure.status === "ACTIVE";
  const semesters = structure.semesters ?? [];

  return (
    <div className={styles.page}>
      {/* ── Structure header ─────────────────────────────────── */}
      <Card className={styles.section}>
        <div className={styles.structureHeader}>
          <div className={styles.structureIdentity}>
            <span className={styles.structureCode}>{structure.programmeCode}</span>
            <h2 className={styles.structureName}>{structure.programmeName}</h2>
            <p className={styles.structureMeta}>
              Academic Session: {structure.academicSession}
            </p>
            <div className={styles.structureBadges}>
              <Badge variant={statusBadgeVariant(structure.status)}>
                {structure.status}
              </Badge>
              <span className={styles.structureMeta}>
                {structure.semesterCount}{" "}
                {structure.semesterCount === 1 ? "semester" : "semesters"} ·{" "}
                {structure.subjectCount}{" "}
                {structure.subjectCount === 1 ? "subject" : "subjects"}
              </span>
            </div>
          </div>

          <div className={styles.toolbarRight}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/admin/academic-structure")}
            >
              <ArrowLeft size={14} /> Back to list
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setProgrammeFormOpen(true)}
            >
              <Pencil size={14} /> Edit Programme
            </Button>
            <Button
              variant={isActive ? "danger" : "teal"}
              size="sm"
              onClick={handleToggleStatus}
              loading={toggling}
            >
              {isActive ? <PowerOff size={14} /> : <Power size={14} />}
              {isActive ? "Deactivate" : "Reactivate"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setSemesterForm({ semester: null })}
            >
              <Plus size={14} /> Add Semester
            </Button>
          </div>
        </div>

        {!isActive && (
          <p className={styles.banner} role="note">
            This programme structure is INACTIVE. It is no longer offered for new
            Syllabus or Result selection, and every semester and subject inside it
            is effectively unavailable. All stored definitions are kept: reactivate
            to make the structure available again.
          </p>
        )}

        {actionError && <p className={styles.formError}>{actionError}</p>}
        {actionSuccess && <p className={styles.formSuccess}>{actionSuccess}</p>}
      </Card>

      {/* ── Semesters ────────────────────────────────────────── */}
      <Card className={styles.section}>
        <CardHeader
          title={`Semesters (${semesters.length})`}
          subtitle="Each semester defines its own subjects, credits, type and assessment structure."
        />

        {semesters.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No semesters defined yet"
            description="Add the first semester, then add its subjects."
          />
        ) : (
          <div className={styles.semesterGrid}>
            {semesters.map((semester) => (
              <SemesterCard
                key={semester.semesterNumber}
                semester={semester}
                structureStatus={structure.status}
                disabled={deleteLoading}
                onEditSemester={(target) => setSemesterForm({ semester: target })}
                onDeleteSemester={confirmDeleteSemester}
                onAddSubject={(target) =>
                  setSubjectForm({ semester: target, subject: null })
                }
                onEditSubject={(target, subject) =>
                  setSubjectForm({ semester: target, subject })
                }
                onDeleteSubject={confirmDeleteSubject}
              />
            ))}
          </div>
        )}
      </Card>

      {/* Programme metadata (name + status only — the identity is fixed). */}
      <ProgrammeStructureForm
        open={programmeFormOpen}
        mode="edit"
        record={structure}
        onClose={() => setProgrammeFormOpen(false)}
        onSave={handleProgrammeSave}
      />

      {/* Add / edit ONE semester (same modal for every semester). */}
      <SemesterForm
        open={!!semesterForm}
        semester={semesterForm?.semester ?? null}
        programmeCode={structure.programmeCode}
        academicSession={structure.academicSession}
        onClose={() => setSemesterForm(null)}
        onSave={handleSemesterSave}
      />

      {/* Add / edit ONE subject (same modal for every subject). */}
      <SubjectForm
        open={!!subjectForm}
        subject={subjectForm?.subject ?? null}
        programmeCode={structure.programmeCode}
        academicSession={structure.academicSession}
        semester={subjectForm?.semester ?? null}
        onClose={() => setSubjectForm(null)}
        onSave={handleSubjectSave}
      />

      {/* One reusable confirmation dialog for every permanent removal. */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => {
          if (!deleteLoading) setPendingDelete(null);
        }}
        onConfirm={runPendingDelete}
        title={pendingDelete?.title ?? ""}
        description={pendingDelete?.description ?? ""}
        confirmLabel={pendingDelete?.confirmLabel ?? "Delete"}
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
