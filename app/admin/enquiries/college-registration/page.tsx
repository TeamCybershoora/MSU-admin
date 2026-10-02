import EnquiriesView from "../enquiries-view";

/**
 * College Registration Enquiries — shows ONLY enquiries of type "affiliation"
 * (the public website's college registration / affiliation form).
 *
 * `affiliation` is the established stored value for college registration
 * enquiries — see @/lib/enquiry-types (mirrored from the public MSU project).
 * The shared view always sends `?type=affiliation` to GET /api/admin/enquiries
 * and the API validates it against the enum before querying, so admission
 * enquiries are never part of this list.
 *
 * The detail modal renders the fields this form actually submits (college
 * name, contact person, designation, district, college type, address,
 * purpose, courses) — no invented fields.
 */
export default function CollegeRegistrationEnquiriesPage() {
  return <EnquiriesView fixedType="affiliation" />;
}
