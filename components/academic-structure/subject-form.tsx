"use client";

/**
 * SubjectForm — ADD a new subject to a semester, or EDIT an existing one.
 *
 * The form captures the whole academic definition of a subject:
 *   identifier  → subjectCode, subjectName
 *   weight      → credits, subjectType
 *   assessment  → internalMax, externalMax, practicalMax (+ derived totalMax)
 *   availability→ status (ACTIVE / INACTIVE)
 *
 * WHAT IS NOT HERE: grades, grade points, SGPA, CGPA and student marks. Those
 * belong to Result logic in a later phase — this form only defines the maximum
 * assessment structure.
 *
 * Total Maximum is READ-ONLY and computed live from the three components, and
 * the server recomputes it again on save, so a stored total can never disagree
 * with its parts.
 */

import { useState } from "react";
import Modal, { ModalScrollable } from "@/components/ui/modal";
import Button from "@/components/ui/button";
import {
  ELECTIVE_SELECTION_RULES,
  ELECTIVE_SELECTION_RULE_LABELS,
  MAX_CREDITS,
  MAX_ELECTIVE_GROUP_CODE_LENGTH,
  STRUCTURE_STATUSES,
  SUBJECT_CATEGORIES,
  SUBJECT_CATEGORY_LABELS,
  SUBJECT_CODE_PATTERN,
  SUBJECT_TYPES,
  SUBJECT_TYPE_LABELS,
  computeTotalMax,
  parseCredits,
  type ElectiveSelectionRule,
  type ProgrammeStructureStatus,
  type SubjectCategory,
  type SubjectType,
} from "@/lib/programme-structure";
import type { ApiOutcome } from "./academic-structure-api";
import { semesterLabel, subjectTypeLabel, type CurriculumSubject, type CurriculumSemester } from "./types";
import styles from "./academic-structure.module.css";

export interface SubjectFormValues {
  subjectCode: string;
  subjectName: string;
  credits: number;
  subjectType: SubjectType;
  category: SubjectCategory;
  status: ProgrammeStructureStatus;
  electiveGroup: string;
  selectionRule: ElectiveSelectionRule | null;
  assessment: {
    internalMax: number;
    externalMax: number;
    practicalMax: number;
    minimumMarks: number | null;
    internalQualifying: boolean;
  };
}

interface SubjectFormProps {
  open: boolean;
  /** Subject being edited, or null when adding a new one. */
  subject: CurriculumSubject | null;
  programmeCode: string;
  academicSession: string;
  semester: CurriculumSemester | null;
  onClose: () => void;
  onSave: (values: SubjectFormValues) => Promise<ApiOutcome>;
}

/** Marks inputs are held as strings so a field can be cleared while typing. */
function marksToText(value: number | undefined): string {
  return value === undefined || value === 0 ? "" : String(value);
}

function parseMarksInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed <= 1000 ? parsed : null;
}

export default function SubjectForm({
  open,
  subject,
  programmeCode,
  academicSession,
  semester,
  onClose,
  onSave,
}: SubjectFormProps) {
  const [subjectCode, setSubjectCode] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [credits, setCredits] = useState("0");
  const [subjectType, setSubjectType] = useState<SubjectType>("THEORY");
  const [category, setCategory] = useState<SubjectCategory>("CORE");
  const [electiveGroup, setElectiveGroup] = useState("");
  const [selectionRule, setSelectionRule] = useState<ElectiveSelectionRule>("ANY_ONE");
  const [internalMax, setInternalMax] = useState("");
  const [externalMax, setExternalMax] = useState("");
  const [practicalMax, setPracticalMax] = useState("");
  const [minimumMarks, setMinimumMarks] = useState("");
  const [internalQualifying, setInternalQualifying] = useState(false);
  const [status, setStatus] = useState<ProgrammeStructureStatus>("ACTIVE");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset on open / when the edited subject changes (see ProgrammeStructureForm
  // for why this is adjusted during render rather than in an effect).
  const [resetFor, setResetFor] = useState<{
    open: boolean;
    subject: CurriculumSubject | null;
  }>({ open, subject });

  if (resetFor.open !== open || resetFor.subject !== subject) {
    setResetFor({ open, subject });
    if (open) {
      setSubjectCode(subject?.subjectCode ?? "");
      setSubjectName(subject?.subjectName ?? "");
      setCredits(subject ? String(subject.credits) : "0");
      setSubjectType(subject?.subjectType ?? "THEORY");
      setCategory(subject?.category ?? "CORE");
      setElectiveGroup(subject?.electiveGroup ?? "");
      setSelectionRule(subject?.selectionRule ?? "ANY_ONE");
      setInternalMax(marksToText(subject?.assessment.internalMax));
      setExternalMax(marksToText(subject?.assessment.externalMax));
      setPracticalMax(marksToText(subject?.assessment.practicalMax));
      setMinimumMarks(marksToText(subject?.assessment.minimumMarks ?? undefined));
      setInternalQualifying(subject?.assessment.internalQualifying ?? false);
      setStatus(subject?.status ?? "ACTIVE");
      setSaving(false);
      setError("");
    }
  }

  // Live preview of the derived total. The server recomputes this on save, so
  // the stored value is always the sum of the parts.
  const totalPreview = computeTotalMax({
    internalMax: parseMarksInput(internalMax) ?? 0,
    externalMax: parseMarksInput(externalMax) ?? 0,
    practicalMax: parseMarksInput(practicalMax) ?? 0,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    const code = subjectCode.trim().toUpperCase();
    const name = subjectName.trim();

    if (!code) {
      setError("Subject code is required.");
      return;
    }
    if (!SUBJECT_CODE_PATTERN.test(code)) {
      setError(
        "Subject code must be 1-30 characters (letters, digits, spaces, dots, underscores, slashes or hyphens)."
      );
      return;
    }
    if (!name) {
      setError("Subject name is required.");
      return;
    }

    const parsedCredits = parseCredits(credits.trim() === "" ? 0 : credits);
    if (parsedCredits === null) {
      setError(`Credits must be a non-negative number (0-${MAX_CREDITS}).`);
      return;
    }

    const internal = parseMarksInput(internalMax);
    const external = parseMarksInput(externalMax);
    const practical = parseMarksInput(practicalMax);

    if (internal === null || external === null || practical === null) {
      setError(
        "Assessment maximums must be non-negative whole numbers (leave blank when not applicable)."
      );
      return;
    }
    if (internal + external + practical <= 0) {
      setError("Set at least one assessment maximum above 0.");
      return;
    }
    if (internalQualifying && internal > 0) {
      setError(
        "An internal component cannot be both qualifying and numerically marked — clear the internal maximum or untick “internal is qualifying”."
      );
      return;
    }

    // Blank means "the curriculum states no pass mark" and is stored as null.
    let parsedMinimum: number | null = null;
    if (minimumMarks.trim() !== "") {
      const value = parseMarksInput(minimumMarks);
      if (value === null) {
        setError("Minimum marks must be a non-negative whole number.");
        return;
      }
      parsedMinimum = value;
    }

    const group = electiveGroup.trim();
    if (group.length > MAX_ELECTIVE_GROUP_CODE_LENGTH) {
      setError(
        `Elective group name cannot exceed ${MAX_ELECTIVE_GROUP_CODE_LENGTH} characters.`
      );
      return;
    }

    setSaving(true);
    setError("");

    const outcome = await onSave({
      subjectCode: code,
      subjectName: name,
      credits: parsedCredits,
      subjectType,
      category,
      status,
      electiveGroup: group,
      // The rule only exists on a group member; a compulsory subject stores null.
      selectionRule: group ? selectionRule : null,
      assessment: {
        internalMax: internal,
        externalMax: external,
        practicalMax: practical,
        minimumMarks: parsedMinimum,
        internalQualifying,
      },
    });

    setSaving(false);
    if (!outcome.success) setError(outcome.message);
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      maxWidth={560}
    >
      <form onSubmit={handleSubmit}>
        <ModalScrollable>
          <h3 className={styles.modalTitle}>
            {subject ? `Edit Subject ${subject.subjectCode}` : "Add New Subject"}
          </h3>
          <p className={styles.modalDesc}>
            {programmeCode} — {academicSession}
            {semester ? ` — ${semesterLabel(semester)}` : ""}
          </p>

          <div className={styles.formFields}>
            <div className={styles.formField}>
              <label htmlFor="subject-code">Subject Code *</label>
              <input
                id="subject-code"
                type="text"
                placeholder="e.g. CS401"
                value={subjectCode}
                onChange={(e) => setSubjectCode(e.target.value)}
                disabled={saving}
                required
              />
              <span className={styles.formHint}>
                Unique inside this semester only — the same code may exist in
                another programme, session or semester.
              </span>
            </div>

            <div className={styles.formField}>
              <label htmlFor="subject-name">Subject Name *</label>
              <input
                id="subject-name"
                type="text"
                placeholder="e.g. Data Structures"
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                disabled={saving}
                required
              />
            </div>

            <div className={styles.formGrid}>
              <div className={styles.formField}>
                <label htmlFor="subject-credits">Credits *</label>
                <input
                  id="subject-credits"
                  type="number"
                  min={0}
                  max={MAX_CREDITS}
                  step="0.5"
                  value={credits}
                  onChange={(e) => setCredits(e.target.value)}
                  disabled={saving}
                  required
                />
              </div>

              <div className={styles.formField}>
                <label htmlFor="subject-type">Subject Type *</label>
                <select
                  id="subject-type"
                  value={subjectType}
                  onChange={(e) => setSubjectType(e.target.value as SubjectType)}
                  disabled={saving}
                >
                  {SUBJECT_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {SUBJECT_TYPE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.formField}>
                <label htmlFor="subject-category">Category</label>
                <select
                  id="subject-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as SubjectCategory)}
                  disabled={saving}
                >
                  {SUBJECT_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {SUBJECT_CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
                <span className={styles.formHint}>
                  Value Added marks a course the university recognises separately
                  (it is not converted into a regular paper).
                </span>
              </div>
            </div>

            <fieldset className={styles.formFieldset}>
              <legend>Elective Group (optional)</legend>

              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="subject-elective-group">Group Name</label>
                  <input
                    id="subject-elective-group"
                    type="text"
                    placeholder="e.g. ELECTIVE-I"
                    value={electiveGroup}
                    onChange={(e) => setElectiveGroup(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className={styles.formField}>
                  <label htmlFor="subject-selection-rule">Selection Rule</label>
                  <select
                    id="subject-selection-rule"
                    value={selectionRule}
                    onChange={(e) =>
                      setSelectionRule(e.target.value as ElectiveSelectionRule)
                    }
                    disabled={saving || !electiveGroup.trim()}
                  >
                    {ELECTIVE_SELECTION_RULES.map((value) => (
                      <option key={value} value={value}>
                        {ELECTIVE_SELECTION_RULE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <span className={styles.formHint}>
                Leave the group blank for a compulsory subject. Subjects sharing a
                group name are treated as alternatives of one another (never all
                compulsory), which is what Result will use to decide which papers a
                student may take.
              </span>
            </fieldset>

            <fieldset className={styles.formFieldset}>
              <legend>Assessment Structure (maximum marks)</legend>

              <div className={styles.formGrid}>
                <div className={styles.formField}>
                  <label htmlFor="subject-internal">Internal Maximum</label>
                  <input
                    id="subject-internal"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="0"
                    value={internalMax}
                    onChange={(e) => setInternalMax(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className={styles.formField}>
                  <label htmlFor="subject-external">External Maximum</label>
                  <input
                    id="subject-external"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="0"
                    value={externalMax}
                    onChange={(e) => setExternalMax(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className={styles.formField}>
                  <label htmlFor="subject-practical">Practical Maximum</label>
                  <input
                    id="subject-practical"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="0"
                    value={practicalMax}
                    onChange={(e) => setPracticalMax(e.target.value)}
                    disabled={saving}
                  />
                </div>

                <div className={styles.formField}>
                  <label htmlFor="subject-minimum">Minimum / Qualifying Marks</label>
                  <input
                    id="subject-minimum"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Not stated"
                    value={minimumMarks}
                    onChange={(e) => setMinimumMarks(e.target.value)}
                    disabled={saving}
                  />
                  <span className={styles.formHint}>
                    Leave blank when the curriculum states no pass mark — it is
                    stored as &quot;not stated&quot;, never as 0.
                  </span>
                </div>

                <div className={`${styles.formField} ${styles.checkboxRow}`}>
                  <input
                    id="subject-internal-qualifying"
                    type="checkbox"
                    checked={internalQualifying}
                    onChange={(e) => setInternalQualifying(e.target.checked)}
                    disabled={saving}
                  />
                  <label htmlFor="subject-internal-qualifying">
                    Internal is qualifying (not numerically marked)
                    <span className={styles.formHint}>
                      For papers whose internal component is only qualifying — use
                      it with an internal maximum of 0 (for example a 2-credit Value
                      Added course examined by a 100-mark external paper).
                    </span>
                  </label>
                </div>

                <div className={styles.formField}>
                  <label htmlFor="subject-total">Total Maximum</label>
                  <input
                    id="subject-total"
                    type="text"
                    value={totalPreview}
                    readOnly
                    tabIndex={-1}
                    aria-readonly="true"
                  />
                  <span className={styles.formHint}>
                    Computed as internal + external + practical.
                  </span>
                </div>
              </div>
            </fieldset>

            <div className={styles.formField}>
              <label htmlFor="subject-status">Status</label>
              <select
                id="subject-status"
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as ProgrammeStructureStatus)
                }
                disabled={saving}
              >
                {STRUCTURE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <span className={styles.formHint}>
                INACTIVE leaves the values stored but makes this subject — with
                its {subjectTypeLabel(subjectType).toLowerCase()} credits and
                assessment structure — unavailable for new selection.
              </span>
            </div>
          </div>

          {error && <p className={styles.formError}>{error}</p>}
        </ModalScrollable>

        <div className={styles.modalActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {subject ? "Update Subject" : "Add Subject"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
