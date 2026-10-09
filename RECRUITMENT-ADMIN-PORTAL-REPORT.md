# Recruitment Management (Admin Portal) — Implementation & Verification Report

**Repository:** `D:\msu Admin\msu-admin` (TeamCybershoora/MSU-admin) — the MSU Admin Portal.
**Feature:** `/admin/recruitment` — CMS/CRUD for the Recruitment content consumed by the public site.
**Status:** ✅ **Complete and verified** for the Admin module. Copy-override editing is documented as future work.
**Date:** 2026-10-08

---

## Implementation

| Area | What was added |
|---|---|
| **Model** | `models/Recruitment.ts` — mirrors the public model exactly (same collection `recruitments`, same fields, same `type` / `status` enums, same indexes). |
| **Types** | `lib/recruitment-types.ts` — the shared `type`/`status` keys, section metadata and the admin record shape. |
| **Validation** | `lib/recruitment-validation.ts` — pure parse/validate helpers used by both the API (authoritative) and the page (UX). |
| **API routes** | `app/api/admin/recruitment/route.ts` — `GET` (list one section + both counts, server-side search/status filter/pagination), `POST` (create), `PUT` (update / publish / reorder / replace document), `DELETE` (delete + remove stored PDF). |
| **Admin page** | `app/admin/recruitment/page.tsx` + `page.module.css` — tabbed management page (Job Openings / Government Orders & Circulars), search, status filter, counts, desktop table + mobile record cards, create/edit modal, delete confirmation, loading/empty/error states. |
| **Upload integration** | Reuses the existing GridFS PDF pipeline end-to-end — no new uploader: `POST /api/admin/syllabus/upload` (store) and `GET /api/syllabus/pdf/[id]` (publicly serve). |
| **Navigation** | `app/admin/layout.tsx` — added `Recruitment Management` (`/admin/recruitment`, `Briefcase` icon) next to the other content modules. |
| **SiteConfig** | Not changed. The public copy keys are established; an admin copy editor is listed as future work (see Remaining Work). |
| **Audit logging** | Not changed. See Important Decisions — content modules do not log, so Recruitment follows that convention. |

### Authorization
Every route calls `authenticateAdmin(req)` first and is rate limited (`admin-recruitment`, 120 req / 15 min per IP). Actions that only need an authenticated admin use the normal role model (no Super-Admin-only gate), matching Notices/News.

---

## Data Contract

Admin writes the **exact** public shape; both apps read/write the same `recruitments` collection:

| Field | Type | Notes |
|---|---|---|
| `type` | `"job-opening" \| "government-order"` | required; selects the section |
| `title` | string | required, ≤200 |
| `description` | string | optional, ≤1000 |
| `publishedDate` | Date | required; one date field for both sections (public contract) — labelled "Publish Date" / "Issue Date" in the UI |
| `documentUrl` | string | absolute public URL of the stored PDF (server-issued only) |
| `documentName` | string | sanitised filename (download name) |
| `status` | `"draft" \| "published"` | default `draft` |
| `displayOrder` | number | ≥0, ascending |
| `isDeleted` | boolean | public API filters it out |
| `createdAt` / `updatedAt` | Date | timestamps |

**No image fields exist anywhere.** Public visibility (`status: "published"` + `isDeleted: false`) and ordering (`displayOrder` asc, then newest date) are preserved exactly, so Admin-created records are immediately readable by `GET /api/recruitment`.

---

## Verification

All tests ran against an **isolated** database (`msu_admin_recruit_e2e` on `127.0.0.1:27018`); the production DB was never touched.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx eslint <new files + layout>` | **exit 0** (0 problems) |
| `npm run build` | **exit 0** — `/admin/recruitment` (static shell) + `/api/admin/recruitment` (dynamic) emitted |
| Admin + public API integration | **43 checks, 0 failures** |
| Browser (headless Chrome) | **27 checks, 0 failures, 0 console errors** |
| Regression smoke (existing admin) | **19 checks, 0 failures** |

### API/runtime coverage (integration suite)
Login; anonymous request rejected (401); empty section + zero counts; invalid section type → 400; PDF upload via the existing endpoint (server-issued URL); create; counts/search/status-filter; drafts hidden publicly; publish → appears publicly; public `documentUrl` match; public **download streams the PDF**; stored PDF publicly served; edit → public reflects it; unpublish → hidden; display-order change reorders; **document replacement removes the superseded PDF**; government-order create/edit/publish/unpublish; arbitrary document URL rejected (400); missing title rejected (400); delete → public empty and the record's PDF removed from storage.

### Browser coverage (headless Chrome + CDP)
Page heading; two section tabs; Add button label per section; server-side search (match / no-match empty state / clear); tab switch empty states; **no horizontal overflow at 320/375/414/768/1024/1280/1440/1920**; mobile (≤600px) shows **record cards** and hides the table; 0 console errors.

### Regression
Dashboard (401 anon / 200 authenticated) and Notices/News/Spotlight/Leadership/Syllabus APIs still work; the sidebar still lists every existing item plus `Recruitment Management`; the News and Notices pages still render.

---

## Files Changed

**Created**
- `models/Recruitment.ts`
- `lib/recruitment-types.ts`
- `lib/recruitment-validation.ts`
- `app/api/admin/recruitment/route.ts`
- `app/admin/recruitment/page.tsx`
- `app/admin/recruitment/page.module.css`

**Modified**
- `app/admin/layout.tsx` — 2 additions only (the `Briefcase` icon import and the `Recruitment Management` nav entry).

---

## Important Decisions

- **One shared collection, mirrored model (not a second collection).** The two apps share MongoDB, so the admin model copies the public schema field-for-field. Admin is the only writer; public stays read-only.
- **Reused the existing PDF storage instead of adding an uploader.** The repo has no ImageKit — documents live in MongoDB GridFS (`lib/pdf-storage.ts`) and are served publicly at `/api/syllabus/pdf/[id]`. Recruitment reuses that pipeline (upload + serve + `isPdfBuffer` signature check + `safePdfFilename` + `deleteSyllabusPdf` cleanup). This avoids a duplicate upload/storage abstraction, per the task's rule. The stored URL path is internal; the public site only needs an absolute http(s) URL.
- **Only server-issued document references are accepted.** `parseSyllabusPdfId` validates `documentUrl`, so an arbitrary URL cannot be stored (verified: 400).
- **Hard delete + PDF cleanup.** Deleting or replacing a record removes the superseded GridFS file, matching the Spotlight/Leadership cleanup convention.
- **Reused the existing UI system:** `Card`, `Button`, `Badge`, `Modal`/`ConfirmDialog`, `RecordList`/`RecordCard`/`RecordField`, `EmptyState`, `ErrorState`, `getStoredToken`.
- **No ActivityLog entries.** `ActivityLog` is deliberately closed to admin-password security events (its enum/model are security-scoped), and no content module (Notices/News/Spotlight/Leadership) logs. Introducing `recruitment.*` actions would require reopening that model; Recruitment therefore follows the existing convention (nothing logged) rather than inventing a second audit system.
- **Server-side search/pagination** (Mongo regex on escaped text + `countDocuments`), so the browser never loads an unbounded dataset.

---

## Remaining Work

### Implemented now
Recruitment model + shared collection contract; authenticated CRUD API (list/counts/search/filter/pagination, create, update, publish/unpublish, reorder, delete); PDF upload/replace/removal via the existing GridFS pipeline; the `/admin/recruitment` page (tabs, search, counts, table + mobile cards, modals, empty/loading/error states, responsive, accessible); sidebar entry.

### Future work (NOT implemented)
- **SiteConfig copy editor.** The public page already reads copy overrides from `SiteConfig` (keys such as `recruitment.page_intro`, `recruitment.job_openings.caption`, `recruitment.government_orders.caption`, …). The Admin site-config API (`GET/PUT /api/admin/site-config`) can already write them, but there is no generic copy-editing UI in the portal, so this was deliberately left for a later phase rather than half-built.
- **ImageKit migration.** The public repo's model comment references ImageKit, but this Admin repo has no ImageKit integration; documents are stored in MongoDB GridFS. If the platform later standardises on ImageKit, the storage layer (not the recruitment contract) would change.
- **Soft-delete / restore.** Deletion is currently a hard delete; the `isDeleted` field exists in the shared contract if a restore workflow is ever wanted.
- **Ground-truth note:** the only document-serving path is the shared `/api/syllabus/pdf/[id]` route. If recruitment PDFs should get their own URL namespace, that is a follow-up naming change, not a functional one.
