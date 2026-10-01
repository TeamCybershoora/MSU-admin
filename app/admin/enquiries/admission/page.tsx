import EnquiriesView from "../enquiries-view";

/**
 * Admission Enquiries — shows ONLY enquiries of type "admission", i.e. the
 * submissions created by the public website's admission enquiry form.
 *
 * Scoping is not cosmetic: the shared view always sends `?type=admission` to
 * GET /api/admin/enquiries, and the API validates that value against the
 * enquiry-type enum before querying, so the separation is enforced server-side.
 * College registration (affiliation) enquiries are never part of this list.
 */
export default function AdmissionEnquiriesPage() {
  return <EnquiriesView fixedType="admission" />;
}
