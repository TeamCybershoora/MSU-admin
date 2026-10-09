"use client";

/**
 * Academic Structure — programme curriculum master data.
 *
 * The top level of the hierarchy: one row per programme + academic session.
 *
 *   Programme Structure → Academic Session → Semester → Subject
 *
 * This page lists, searches, filters and creates those structures, and offers
 * the reversible actions first (Edit / Deactivate / Reactivate). Permanent
 * deletion is offered last and is refused server-side while a structure is
 * ACTIVE, so curriculum that has been used is deactivated rather than destroyed.
 *
 * The curriculum itself (semesters and subjects) lives on the manage page,
 * reached with [Manage] — the list only shows Programme, Academic Session,
 * Status, Semester Count and a compact subject count.
 *
 * Data flow (all protected, all server-validated):
 *   GET    /api/admin/academic-structure            list (search + status + paging)
 *   POST   /api/admin/academic-structure            create
 *   PATCH  /api/admin/academic-structure            rename / activate / deactivate
 *   DELETE /api/admin/academic-structure?…          permanent delete (INACTIVE only)
 *
 * This phase deliberately does NOT read or write Syllabus or Result data.
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  Layers,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import Badge from "@/components/ui/badge";
import SearchableSelect from "@/components/ui/searchable-select";
import Button from "@/components/ui/button";
import Card, { CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/modal";
import RecordList, { RecordCard, RecordField } from "@/components/ui/record-list";
import EmptyState from "@/components/empty-state";
import ErrorState from "@/components/error-state";
import ProgrammeStructureForm, {
  type ProgrammeStructureFormValues,
} from "@/components/academic-structure/programme-structure-form";
import {
  createProgrammeStructure,
  deleteProgrammeStructure,
  listProgrammeStructures,
  updateProgrammeStructure,
  type ApiOutcome,
} from "@/components/academic-structure/academic-structure-api";
import {
  statusBadgeVariant,
  type Pagination,
  type ProgrammeStructureSummary,
} from "@/components/academic-structure/types";
import styles from "./page.module.css";

/**
 * Number of subjects counted in a confirmation message — the summary row does
 * not carry the subject list, only its count.
 */
export default function AdminAcademicStructurePage() {
  const router = useRouter();

  const [structures, setStructures] = useState<ProgrammeStructureSummary[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [formTarget, setFormTarget] = useState<{
    mode: "create" | "edit";
    record: ProgrammeStructureSummary | null;
  } | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [busyId, setBusyId] = useState("");

  const [pendingDelete, setPendingDelete] =
    useState<ProgrammeStructureSummary | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Monotonic request id: only the newest request may write state, so a slow
  // earlier response can never overwrite a newer (filtered) one.
  const requestSeq = useRef(0);

  const fetchStructures = useCallback(
    async (page = 1) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      try {
        const result = await listProgrammeStructures({
          page,
          search,
          status: statusFilter,
        });

        if (seq !== requestSeq.current) return;
        if (!result.success) {
          setError(result.message || "Unable to load programme structures.");
          return;
        }

        setStructures(result.data ?? []);
        if (result.pagination) setPagination(result.pagination);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [search, statusFilter]
  );

  // Single source of refetch: filter/search handlers only set state — an
  // immediate refetch there would run a stale closure and race this request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchStructures(1); }, [fetchStructures]);

  function flashSuccess(message: string) {
    setActionError("");
    setActionSuccess(message);
    window.setTimeout(() => setActionSuccess(""), 4000);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    fetchStructures(1);
  }

  /* ── Create / edit ─────────────────────────────────────────── */

  async function handleFormSave(
    values: ProgrammeStructureFormValues
  ): Promise<ApiOutcome> {
    const target = formTarget;
    if (!target) return { success: false, message: "No programme selected." };

    if (target.mode === "edit" && target.record) {
      // Only the mutable fields are sent; the identity pair is fixed server-side.
      const outcome = await updateProgrammeStructure(target.record.id, {
        programmeName: values.programmeName,
        status: values.status,
      });

      if (outcome.success) {
        setFormTarget(null);
        await fetchStructures(pagination.page);
        flashSuccess("Programme structure updated.");
      }
      return outcome;
    }

    const outcome = await createProgrammeStructure(values);
    if (outcome.success) {
      setFormTarget(null);
      await fetchStructures(1);
      flashSuccess("Programme structure created. Add its semesters next.");
    }
    return outcome;
  }

  /* ── Activate / deactivate (the reversible route) ───────────── */

  async function handleToggleStatus(structure: ProgrammeStructureSummary) {
    if (busyId) return;
    setBusyId(structure.id);
    setActionError("");

    const nextStatus = structure.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      const outcome = await updateProgrammeStructure(structure.id, {
        status: nextStatus,
      });

      if (!outcome.success) {
        setActionSuccess("");
        setActionError(outcome.message);
        return;
      }

      await fetchStructures(pagination.page);
      flashSuccess(
        nextStatus === "INACTIVE"
          ? `${structure.programmeCode} (${structure.academicSession}) deactivated — its semesters and subjects are no longer offered for new selection, and every stored record is kept.`
          : `${structure.programmeCode} (${structure.academicSession}) reactivated.`
      );
    } finally {
      setBusyId("");
    }
  }

  /* ── Permanent delete (INACTIVE only, explicitly confirmed) ─── */

  async function handleDelete() {
    const target = pendingDelete;
    if (!target || deleteLoading) return;

    setDeleteLoading(true);
    setActionError("");
    try {
      const outcome = await deleteProgrammeStructure(target.id);
      if (!outcome.success) {
        setActionSuccess("");
        setActionError(outcome.message);
        return;
      }

      await fetchStructures(pagination.page);
      flashSuccess(outcome.message);
    } finally {
      setDeleteLoading(false);
      setPendingDelete(null);
    }
  }

  return (
    <div className={styles.page}>
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <Card className={styles.section}>
        <div className={styles.toolbar}>
          <form onSubmit={handleSearch} className={styles.searchForm}>
            <div className={styles.searchInput}>
              <Search size={16} />
              <input
                type="text"
                placeholder="Search by programme or session..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => {
                    setSearch("");
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className={styles.filterRow}>
              <Filter size={14} />
              <SearchableSelect
                id="academic-structure-status-filter"
                variant="compact"
                label="Filter by status"
                placeholder="All Statuses"
                value={statusFilter}
                options={[
                  { value: "", label: "All Statuses" },
                  { value: "ACTIVE", label: "ACTIVE" },
                  { value: "INACTIVE", label: "INACTIVE" },
                ]}
                triggerClassName={styles.select}
                onChange={(value) => {
                  setStatusFilter(value);
                }}
              />
            </div>
            <Button type="submit" variant="primary" size="sm">
              <Search size={14} /> Search
            </Button>
          </form>
          <div className={styles.toolbarRight}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setFormTarget({ mode: "create", record: null })}
            >
              <Plus size={14} /> Add Programme Structure
            </Button>
          </div>
        </div>

        {actionError && <p className={styles.formError}>{actionError}</p>}
        {actionSuccess && <p className={styles.formSuccess}>{actionSuccess}</p>}
      </Card>

      {/* ── List ────────────────────────────────────────────── */}
      <Card className={styles.section}>
        <CardHeader
          title={`Programme Structures (${pagination.total})`}
          subtitle="The master definition of what each programme teaches in an academic session."
        />

        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <p>Loading programme structures...</p>
          </div>
        ) : error ? (
          <ErrorState
            title="Unable to load programme structures"
            description={error}
            onRetry={() => fetchStructures(pagination.page)}
          />
        ) : structures.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No programme structures found"
            description={
              search || statusFilter
                ? "No programme structures match your criteria."
                : "Add a programme structure to define the subjects taught in an academic session."
            }
          />
        ) : (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Programme</th>
                    <th>Academic Session</th>
                    <th>Status</th>
                    <th>Semesters</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {structures.map((structure) => (
                    <tr key={structure.id}>
                      <td className={styles.nameCell}>
                        {structure.programmeName}
                        <div className={styles.monoCell}>
                          {structure.programmeCode}
                        </div>
                      </td>
                      <td>{structure.academicSession}</td>
                      <td>
                        <Badge variant={statusBadgeVariant(structure.status)}>
                          {structure.status}
                        </Badge>
                      </td>
                      <td className={styles.mutedCell}>
                        {structure.semesterCount}{" "}
                        {structure.semesterCount === 1 ? "semester" : "semesters"}
                        {" · "}
                        {structure.subjectCount}{" "}
                        {structure.subjectCount === 1 ? "subject" : "subjects"}
                      </td>
                      <td className={styles.actionsCell}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            router.push(`/admin/academic-structure/${structure.id}`)
                          }
                          title="Manage semesters and subjects"
                        >
                          <Settings2 size={14} /> Manage
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="Edit programme details"
                          aria-label={`Edit ${structure.programmeCode}`}
                          onClick={() =>
                            setFormTarget({ mode: "edit", record: structure })
                          }
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title={
                            structure.status === "ACTIVE"
                              ? "Deactivate (reversible)"
                              : "Reactivate"
                          }
                          aria-label={`${
                            structure.status === "ACTIVE" ? "Deactivate" : "Reactivate"
                          } ${structure.programmeCode}`}
                          disabled={busyId === structure.id}
                          onClick={() => handleToggleStatus(structure)}
                        >
                          {structure.status === "ACTIVE" ? (
                            <PowerOff size={15} />
                          ) : (
                            <Power size={15} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          title="Delete permanently (INACTIVE only)"
                          aria-label={`Delete ${structure.programmeCode}`}
                          onClick={() => setPendingDelete(structure)}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile only (<=600px): the same structures array as the table
                above, rendered as record cards. Hidden on desktop/tablet. */}
            <RecordList>
              {structures.map((structure) => (
                <RecordCard
                  key={structure.id}
                  title={structure.programmeName}
                  subtitle={`${structure.programmeCode} · ${structure.academicSession}`}
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Manage semesters and subjects"
                        aria-label={`Manage ${structure.programmeCode}`}
                        onClick={() =>
                          router.push(`/admin/academic-structure/${structure.id}`)
                        }
                      >
                        <Settings2 size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Edit programme details"
                        aria-label={`Edit ${structure.programmeCode}`}
                        onClick={() =>
                          setFormTarget({ mode: "edit", record: structure })
                        }
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title={
                          structure.status === "ACTIVE"
                            ? "Deactivate (reversible)"
                            : "Reactivate"
                        }
                        aria-label={`${
                          structure.status === "ACTIVE" ? "Deactivate" : "Reactivate"
                        } ${structure.programmeCode}`}
                        disabled={busyId === structure.id}
                        onClick={() => handleToggleStatus(structure)}
                      >
                        {structure.status === "ACTIVE" ? (
                          <PowerOff size={15} />
                        ) : (
                          <Power size={15} />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        title="Delete permanently (INACTIVE only)"
                        aria-label={`Delete ${structure.programmeCode}`}
                        onClick={() => setPendingDelete(structure)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </>
                  }
                >
                  <RecordField label="Status">
                    <Badge variant={statusBadgeVariant(structure.status)}>
                      {structure.status}
                    </Badge>
                  </RecordField>
                  <RecordField label="Semesters">
                    {structure.semesterCount}
                  </RecordField>
                  <RecordField label="Subjects">
                    {structure.subjectCount}
                  </RecordField>
                </RecordCard>
              ))}
            </RecordList>

            {pagination.totalPages > 1 && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => fetchStructures(pagination.page - 1)}
                >
                  <ChevronLeft size={14} /> Previous
                </Button>
                <span className={styles.pageInfo}>
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => fetchStructures(pagination.page + 1)}
                >
                  Next <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Create / edit — the same modal for every programme. */}
      <ProgrammeStructureForm
        open={!!formTarget}
        mode={formTarget?.mode ?? "create"}
        record={formTarget?.record ?? null}
        onClose={() => setFormTarget(null)}
        onSave={handleFormSave}
      />

      {/* Permanent deletion is destructive and, for curriculum that may already
          be referenced, discouraged — deactivation is the reversible option. */}
      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => {
          if (!deleteLoading) setPendingDelete(null);
        }}
        onConfirm={handleDelete}
        title="Permanently delete this programme structure?"
        description={
          pendingDelete
            ? `This deletes the ${pendingDelete.programmeCode} (${pendingDelete.academicSession}) curriculum — ${pendingDelete.semesterCount} semester(s) and ${pendingDelete.subjectCount} subject(s) — and cannot be undone. Deactivate it instead to keep the curriculum for reference. Existing Syllabus and Result records are NOT deleted by this action, and a structure must be INACTIVE before it can be deleted.`
            : ""
        }
        confirmLabel="Delete Permanently"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
