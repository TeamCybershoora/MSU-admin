/**
 * Offline verification of lib/enquiry-validation.ts and the enquiry vocabulary.
 *
 * Runs entirely in memory: it never connects to MongoDB, never sends email and
 * never reads an environment value. It covers the query-string parsing that
 * feeds the enquiries list API (pagination, filters, search), the status
 * transition rules, the reply/status input rules and the reference used as the
 * URL identifier.
 *
 * The pagination cases exist because the other list APIs in this project parse
 * `?page=`/`?limit=` with a bare `parseInt`, which yields NaN for non-numeric
 * input and turns `?page=abc` into a 500. The enquiry API must not do that.
 *
 * Usage: npx tsx scripts/test-enquiry-validation.ts
 */
import {
  ENQUIRY_STATUSES,
  ENQUIRY_TYPES,
  ENQUIRY_REFERENCE_PATTERN,
  isEnquiryReference,
  isEnquiryStatus,
  isEnquiryType,
  isValidContactNumber,
  normalizePhone,
} from "@/lib/enquiry-types";
import {
  ENQUIRY_DEFAULT_LIMIT,
  ENQUIRY_MAX_LIMIT,
  ENQUIRY_REPLY_MAX_LENGTH,
  ENQUIRY_REPLY_MIN_LENGTH,
  ENQUIRY_SEARCH_MAX_LENGTH,
  allowedTransitions,
  canReplyFrom,
  canTransition,
  parseEnquiryPagination,
  parseEnquiryReferenceParam,
  parseEnquirySearch,
  parseEnquiryStatusFilter,
  parseEnquiryTypeFilter,
  validateReplyMessage,
  validateStatusInput,
} from "@/lib/enquiry-validation";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

/** Build pagination from a raw query string, e.g. "page=abc&limit=2". */
function paginate(query: string) {
  return parseEnquiryPagination(new URLSearchParams(query));
}

/* ── Vocabulary ─────────────────────────────────────────────── */

section("Vocabulary cannot drift from the public schema");

check(
  "types are admission + affiliation + general",
  ENQUIRY_TYPES.join(",") === "admission,affiliation,general"
);
check("the type guard accepts the general type", isEnquiryType("general"));
check(
  "statuses stay in the public order",
  ENQUIRY_STATUSES.join(",") === "new,in_review,responded,closed"
);
check("the stored value is in_review, not review", isEnquiryStatus("in_review") && !isEnquiryStatus("review"));
check("unknown statuses are rejected", !isEnquiryStatus("pending") && !isEnquiryStatus(""));
check("a type guard accepts the two real types", isEnquiryType("admission") && isEnquiryType("affiliation"));
check("a type guard rejects anything else", !isEnquiryType("registration"));

/* ── Reference ──────────────────────────────────────────────── */

section("Reference format (MSU-ENQ-XXXXXXXX)");

check("a real reference validates", isEnquiryReference("MSU-ENQ-48J7PRKQ"));
// The strict validator is UPPERCASE-ONLY, exactly like the public schema's
// validator: the schema sets `uppercase: true` (applied before validation), and
// the Admin URL parser uppercases before calling it. Case tolerance therefore
// belongs to the parser, not to this validator.
check("the strict validator is uppercase-only, as in the public schema", !isEnquiryReference("msu-enq-48j7prkq"));
check("excluded glyphs (I, L, O, U) are rejected", !isEnquiryReference("MSU-ENQ-48J7PRKI") && !isEnquiryReference("MSU-ENQ-48J7PRKO"));
check("a bare id is not a reference", !isEnquiryReference("48J7PRKQ"));
check("a short body is rejected", !isEnquiryReference("MSU-ENQ-48J7PRK"));
check("the ObjectId-looking value is rejected", !isEnquiryReference("507f1f77bcf86cd799439011"));
check("the pattern is anchored at the start", ENQUIRY_REFERENCE_PATTERN.source.startsWith("^"));
check("the pattern is anchored at the end", ENQUIRY_REFERENCE_PATTERN.source.endsWith("$"));

section("Reference as a URL identifier");

check("a valid reference is uppercased", parseEnquiryReferenceParam("msu-enq-48j7prkq") === "MSU-ENQ-48J7PRKQ");
check("surrounding whitespace is tolerated", parseEnquiryReferenceParam("  MSU-ENQ-48J7PRKQ ") === "MSU-ENQ-48J7PRKQ");
check("a non-reference is rejected", parseEnquiryReferenceParam("48J7PRKQ") === null);
check("a non-string is rejected", parseEnquiryReferenceParam(undefined) === null);
check("a query-operator suffix cannot pass", parseEnquiryReferenceParam("MSU-ENQ-48J7PRKQ$ne") === null);
check("a path-traversal attempt cannot pass", parseEnquiryReferenceParam("../enquiries") === null);

/* ── Pagination ─────────────────────────────────────────────── */

section("Pagination never yields NaN (the parseInt bug)");

check("missing params use the defaults", paginate("").page === 1 && paginate("").limit === ENQUIRY_DEFAULT_LIMIT);
check("valid values are honoured", paginate("page=3&limit=50").page === 3 && paginate("page=3&limit=50").skip === 100);
check("skip is (page - 1) * limit", paginate("page=2&limit=20").skip === 20);

for (const raw of ["abc", "hello", "-1", "1.5", "1e3", "", " ", "1abc", "٤"]) {
  const p = paginate(`page=${encodeURIComponent(raw)}&limit=${encodeURIComponent(raw)}`);
  check(
    `page/limit "${raw}" falls back without NaN`,
    p.page === 1 &&
      p.limit === ENQUIRY_DEFAULT_LIMIT &&
      p.skip === 0 &&
      ![p.page, p.limit, p.skip].some((n) => !Number.isFinite(n))
  );
}

check("page=0 falls back to 1", paginate("page=0").page === 1);
check("limit=0 falls back to the default", paginate("limit=0").limit === ENQUIRY_DEFAULT_LIMIT);
check("an oversized page falls back to 1", paginate("page=99999999999999999999").page === 1);
check(`limit is capped at ${ENQUIRY_MAX_LIMIT}`, paginate("limit=100000").limit === ENQUIRY_MAX_LIMIT);
check("a negative limit falls back to the default", paginate("limit=-5").limit === ENQUIRY_DEFAULT_LIMIT);
check("every result is a finite integer", [
  paginate("page=abc"),
  paginate("page=0&limit=0"),
  paginate("limit=1e9"),
].every(
  (p) =>
    Number.isInteger(p.page) &&
    Number.isInteger(p.limit) &&
    Number.isInteger(p.skip) &&
    p.page >= 1 &&
    p.limit >= 1
));

/* ── Filters ────────────────────────────────────────────────── */

section("Filters accept only the stored vocabulary");

check("type=admission filters", parseEnquiryTypeFilter("admission") === "admission");
check("type=affiliation filters", parseEnquiryTypeFilter("affiliation") === "affiliation");
check("an unknown type means no filter", parseEnquiryTypeFilter("registration") === "");
check("the All sentinel means no filter", parseEnquiryTypeFilter("All") === "");
check("an absent type means no filter", parseEnquiryTypeFilter(null) === "");

check("status=new filters", parseEnquiryStatusFilter("new") === "new");
check('status="review" is NOT accepted (the stored value is in_review)', parseEnquiryStatusFilter("review") === "");
check("status=in_review filters", parseEnquiryStatusFilter("in_review") === "in_review");
check("status=responded filters", parseEnquiryStatusFilter("responded") === "responded");
check("status=closed filters", parseEnquiryStatusFilter("closed") === "closed");
check("an unknown status means no filter", parseEnquiryStatusFilter("pending") === "");

section("Search term handling");

check("a search term is trimmed", parseEnquirySearch("  MSU-ENQ-48J7PRKQ  ") === "MSU-ENQ-48J7PRKQ");
check("an absent search means no filter", parseEnquirySearch(null) === "" && parseEnquirySearch(undefined) === "");
check(
  `a very long term is truncated to ${ENQUIRY_SEARCH_MAX_LENGTH}`,
  parseEnquirySearch("a".repeat(500)).length === ENQUIRY_SEARCH_MAX_LENGTH
);
check("regex metacharacters survive intact for escapeRegex to neutralise", parseEnquirySearch(".*+?^${}()|[]\\") === ".*+?^${}()|[]\\");

/* ── Status workflow ────────────────────────────────────────── */

section("Status transitions are enforced");

check("new -> in_review is allowed", canTransition("new", "in_review"));
check("new -> closed is allowed", canTransition("new", "closed"));
check("new -> responded is NOT allowed (must be reviewed first)", !canTransition("new", "responded"));
check("in_review -> responded is allowed", canTransition("in_review", "responded"));
check("in_review -> closed is allowed", canTransition("in_review", "closed"));
check("in_review -> new is NOT allowed", !canTransition("in_review", "new"));
check("responded -> closed is allowed", canTransition("responded", "closed"));
check("responded -> in_review (reopen) is allowed", canTransition("responded", "in_review"));
check("closed -> in_review (reopen) is allowed", canTransition("closed", "in_review"));
check("closed -> responded is NOT allowed", !canTransition("closed", "responded"));
check("setting the current status again is not a transition", !canTransition("new", "new") && !canTransition("closed", "closed"));
check("an arbitrary status is never a transition", !canTransition("new", "resolved") && !canTransition("new", ""));
check("an unknown starting status has no transitions", allowedTransitions("pending").length === 0);
check("every allowed transition target is a real status", ENQUIRY_STATUSES.every((status) =>
  allowedTransitions(status).every((target) => isEnquiryStatus(target))
));

section("Status input validation");

check("a valid status is accepted", (() => { const r = validateStatusInput("in_review"); return r.ok && r.value === "in_review"; })());
check('"review" is rejected with a clear message', (() => { const r = validateStatusInput("review"); return !r.ok && r.message.includes("in_review"); })());
check("an arbitrary status is rejected", !validateStatusInput("resolved").ok);
check("a non-string status is rejected", !validateStatusInput(42).ok);
check("an empty status is rejected", !validateStatusInput("").ok);

/* ── Reply rules ────────────────────────────────────────────── */

section("Reply rules");

check("a reply is allowed from new", canReplyFrom("new"));
check("a reply is allowed from in_review", canReplyFrom("in_review"));
check("a reply is allowed from responded", canReplyFrom("responded"));
check("a reply is NOT allowed from closed", !canReplyFrom("closed"));
check("a reply is NOT allowed from an unknown status", !canReplyFrom("pending"));

check("a normal reply validates", (() => { const r = validateReplyMessage("Thank you for your enquiry."); return r.ok && r.value === "Thank you for your enquiry."; })());
check("a reply is trimmed", (() => { const r = validateReplyMessage("   Thank you for your enquiry.   "); return r.ok && r.value === "Thank you for your enquiry."; })());
check(`a reply shorter than ${ENQUIRY_REPLY_MIN_LENGTH} is rejected`, !validateReplyMessage("short").ok);
check("an empty reply is rejected", !validateReplyMessage("").ok && !validateReplyMessage("      ").ok);
check("a non-string reply is rejected", !validateReplyMessage(null).ok && !validateReplyMessage({ message: "hi" }).ok);
check(`a reply longer than ${ENQUIRY_REPLY_MAX_LENGTH} is rejected`, !validateReplyMessage("a".repeat(ENQUIRY_REPLY_MAX_LENGTH + 1)).ok);
check(`a reply of exactly ${ENQUIRY_REPLY_MAX_LENGTH} is accepted`, validateReplyMessage("a".repeat(ENQUIRY_REPLY_MAX_LENGTH)).ok);

/* ── Contact numbers (public compatibility) ─────────────────── */

section("Phone normalisation matches the public schema");

check("a bare 10-digit number is valid", isValidContactNumber("9876543210"));
check("+91 is stripped", normalizePhone("+91 98765 43210") === "9876543210");
check("a 0 prefix is stripped", normalizePhone("098765 43210") === "9876543210");
check("dashes and brackets are tolerated", isValidContactNumber("(98765)-43210"));
check("a 9-digit number is rejected", !isValidContactNumber("987654321"));
check("letters are rejected", !isValidContactNumber("98765abcde"));

/* ── Summary ────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All enquiry validation checks passed.");
}
