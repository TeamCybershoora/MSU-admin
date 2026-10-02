"use client";

/**
 * SemesterCard — one semester of a programme structure and its subjects.
 *
 * Rendered from data for every semester of every structure, so the same card
 * manages BCA Semester IV and B.Tech Semester II; no programme, semester or
 * subject is hard-coded. Every action is delegated upward with the record it was
 * given.
 *
 * COMPULSORY PAPERS vs ELECTIVE GROUPS:
 * subjects are split with partitionSubjects(). Compulsory papers render as one
 * list; every elective group renders in its own labelled block with its
 * selection rule ("Select any one") above its options, so the two alternatives of
 * ELECTIVE-I are never presented as two more compulsory papers — the distinction
 * Result will later depend on.
 *
 * STATUS IS EFFECTIVE, NOT JUST STORED:
 * the badge shows what the subject is actually available for. A subject whose
 * own status is ACTIVE but whose semester (or programme structure) is INACTIVE
 * is displayed as INACTIVE, because that is the truth for new selection — and
 * the stored status of every child is left untouched, so reactivating the parent
 * restores exactly the previous state.
 *
 * Desktop renders the dense table; at the project's 600px mobile breakpoint the
 * table is replaced by record cards built from the same data
 * (components/ui/record-list.tsx).
 */

import { Edit3, Plus, Trash2 } from "lucide-react";
import Badge from "@/components/ui/badge";
import Button from "@/components/ui/button";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import {
  effectiveStatus,
  type ProgrammeStructureStatus,
} from "@/lib/programme-structure";
import {
  formatAssessment,
  partitionSubjects,
  selectionRuleLabel,
  semesterLabel,
  statusBadgeVariant,
  subjectCategoryLabel,
  subjectTypeLabel,
  type CurriculumSemester,
  type CurriculumSubject,
} from "./types";
import styles from "./academic-structure.module.css";

interface SemesterCardProps {
  semester: CurriculumSemester;
  /** Status of the parent structure — gates every subject in this semester. */
  structureStatus: ProgrammeStructureStatus;
  disabled?: boolean;
  onEditSemester: (semester: CurriculumSemester) => void;
  onDeleteSemester: (semester: CurriculumSemester) => void;
  onAddSubject: (semester: CurriculumSemester) => void;
  onEditSubject: (semester: CurriculumSemester, subject: CurriculumSubject) => void;
  onDeleteSubject: (semester: CurriculumSemester, subject: CurriculumSubject) => void;
}

export default function SemesterCard({
  semester,
  structureStatus,
  disabled = false,
  onEditSemester,
  onDeleteSemester,
  onAddSubject,
  onEditSubject,
  onDeleteSubject,
}: SemesterCardProps) {
  const subjects = semester.subjects ?? [];
  const semesterStatus = effectiveStatus(structureStatus, semester.status);
  const { compulsory, groups } = partitionSubjects(subjects);

  function subjectNote(subject: CurriculumSubject, effective: ProgrammeStructureStatus) {
    if (subject.status === "INACTIVE") {
      return "Subject is INACTIVE: its credits and assessment structure are unavailable for new Syllabus/Result selection (the stored values are kept).";
    }
    if (effective === "INACTIVE") {
      return "Effectively unavailable: a parent (semester or programme structure) is INACTIVE. The subject's own stored status is unchanged.";
    }
    return "Available for new Syllabus/Result selection.";
  }

  /**
   * Desktop table + mobile record cards for one list of subjects. Called once
   * for the compulsory papers and once per elective group, so both
   * representations always show identical information.
   */
  function renderSubjectList(list: CurriculumSubject[]) {
    return (
      <>
        <div className={styles.tableWrapper}>
          <table className={styles.subjectTable}>
            <thead>
              <tr>
                <th>Subject Code</th>
                <th>Subject Name</th>
                <th>Credits</th>
                <th>Type</th>
                <th>Assessment</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((subject) => {
                const effective = effectiveStatus(semesterStatus, subject.status);
                return (
                  <tr key={subject.subjectCode}>
                    <td className={styles.monoCell}>{subject.subjectCode}</td>
                    <td className={styles.nameCell}>
                      {subject.subjectName}
                      {subject.category !== "CORE" && (
                        <span className={styles.categoryChip}>
                          {subjectCategoryLabel(subject.category)}
                        </span>
                      )}
                    </td>
                    <td>{subject.credits}</td>
                    <td>{subjectTypeLabel(subject.subjectType)}</td>
                    <td className={styles.assessmentCell}>
                      {formatAssessment(subject.assessment)}
                    </td>
                    <td title={subjectNote(subject, effective)}>
                      <Badge
                        variant={statusBadgeVariant(effective)}
                        className={styles.statusBadge}
                      >
                        {effective}
                      </Badge>
                    </td>
                    <td className={styles.actionsCell}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Edit subject"
                        aria-label={`Edit ${subject.subjectCode}`}
                        onClick={() => onEditSubject(semester, subject)}
                        disabled={disabled}
                      >
                        <Edit3 size={15} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Delete subject"
                        aria-label={`Delete ${subject.subjectCode}`}
                        onClick={() => onDeleteSubject(semester, subject)}
                        disabled={disabled}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile only (<=600px): the same subjects array as the table above,
            rendered as record cards. Hidden on desktop/tablet. */}
        <RecordList>
          {list.map((subject) => {
            const effective = effectiveStatus(semesterStatus, subject.status);
            return (
              <RecordCard
                key={subject.subjectCode}
                title={subject.subjectCode}
                subtitle={subject.subjectName}
                actions={
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Edit subject"
                      aria-label={`Edit ${subject.subjectCode}`}
                      onClick={() => onEditSubject(semester, subject)}
                      disabled={disabled}
                    >
                      <Edit3 size={15} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      iconOnly
                      title="Delete subject"
                      aria-label={`Delete ${subject.subjectCode}`}
                      onClick={() => onDeleteSubject(semester, subject)}
                      disabled={disabled}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </>
                }
              >
                <RecordField label="Credits">{subject.credits}</RecordField>
                <RecordField label="Type">
                  {subjectTypeLabel(subject.subjectType)}
                  {subject.category !== "CORE"
                    ? ` · ${subjectCategoryLabel(subject.category)}`
                    : ""}
                </RecordField>
                {subject.electiveGroup && (
                  <RecordField label="Elective">{subject.electiveGroup}</RecordField>
                )}
                <RecordField label="Assessment">
                  {formatAssessment(subject.assessment)}
                </RecordField>
                <RecordField label="Status">
                  <span title={subjectNote(subject, effective)}>
                    <Badge variant={statusBadgeVariant(effective)}>{effective}</Badge>
                  </span>
                  {effective !== subject.status && (
                    <span className={styles.mutedInline}>
                      {" "}
                      (own status: {subject.status})
                    </span>
                  )}
                </RecordField>
              </RecordCard>
            );
          })}
        </RecordList>
      </>
    );
  }

  return (
    <section className={styles.semesterCard}>
      <div className={styles.semesterHeader}>
        <div className={styles.semesterIdentity}>
          <h4 className={styles.semesterTitle}>{semesterLabel(semester)}</h4>
          <p className={styles.semesterMeta}>
            {subjects.length} {subjects.length === 1 ? "Subject" : "Subjects"}
            {groups.length > 0 &&
              ` · ${groups.length} elective ${
                groups.length === 1 ? "group" : "groups"
              }`}
          </p>
        </div>
        <div className={styles.semesterBadges}>
          <Badge variant={statusBadgeVariant(semester.status)}>
            {semester.status}
          </Badge>
        </div>
      </div>

      {semesterStatus === "INACTIVE" && (
        <p className={styles.statusNote} role="note">
          {semester.status === "INACTIVE"
            ? "This semester is INACTIVE: every subject inside it is effectively unavailable for new selection, without any subject record being changed."
            : "The programme structure is INACTIVE: this semester and its subjects are effectively unavailable for new selection."}
        </p>
      )}

      <div className={styles.rowActions}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onEditSemester(semester)}
          disabled={disabled}
        >
          <Edit3 size={14} /> Edit Semester
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => onDeleteSemester(semester)}
          disabled={disabled}
        >
          <Trash2 size={14} /> Delete Semester
        </Button>
      </div>

      {subjects.length === 0 ? (
        <p className={styles.emptyHint}>
          No subjects in this semester yet. Use “Add Subject” below.
        </p>
      ) : (
        <>
          {compulsory.length > 0 && renderSubjectList(compulsory)}

          {/* Elective groups: alternatives, not additional compulsory papers. */}
          {groups.map((group) => (
            <div key={group.code} className={styles.electiveGroup}>
              <div className={styles.electiveHeader}>
                <h5 className={styles.electiveTitle}>{group.code}</h5>
                {group.selectionRule && (
                  <Badge variant="info">
                    {selectionRuleLabel(group.selectionRule)}
                  </Badge>
                )}
                <span className={styles.mutedInline}>
                  {group.options.length}{" "}
                  {group.options.length === 1 ? "option" : "options"} — choose one,
                  these are alternatives
                </span>
              </div>
              {renderSubjectList(group.options)}
            </div>
          ))}
        </>
      )}

      <div className={styles.semesterFooter}>
        <Button
          type="button"
          variant="teal"
          size="sm"
          onClick={() => onAddSubject(semester)}
          disabled={disabled}
        >
          <Plus size={14} /> Add Subject
        </Button>
      </div>
    </section>
  );
}
