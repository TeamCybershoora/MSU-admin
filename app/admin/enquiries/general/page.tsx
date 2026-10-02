import EnquiriesView from "../enquiries-view";

/**
 * General Enquiries — shows ONLY enquiries of type "general", i.e. the
 * submissions created by the public website's Contact Us general enquiry form.
 *
 * Scoping is enforced server-side: the shared view always sends
 * `?type=general` to GET /api/admin/enquiries and the API validates that value
 * against the enquiry-type enum before querying, so admission and college
 * registration enquiries are never part of this list.
 *
 * General enquiries carry no type-specific fields; the whole description is the
 * message. The page therefore adds a keyword Category filter and an optional
 * saved Classification, both of which live only on this page.
 */
export default function GeneralEnquiriesPage() {
  return <EnquiriesView fixedType="general" />;
}
