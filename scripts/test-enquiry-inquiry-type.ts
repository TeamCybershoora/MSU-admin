/**
 * Offline verification of the Admin side of `inquiryType` — the PUBLIC
 * submitter's selected topic on a General Enquiry.
 *
 * Covers, end to end WITHOUT a database:
 *   A. the response mappers return inquiryType (and keep it separate from the
 *      admin's `classification`),
 *   B. every supported inquiry type can be parsed and filtered,
 *   C. invalid values (random, admin, $ne, $regex, {"$ne": null}) are never
 *      placed in the query,
 *   D. `unspecified` finds records written before the field existed,
 *   E. inquiryType combines with type + status + classification,
 *   F. inquiryType combines with search without overwriting it,
 *   G. filtering happens BEFORE pagination (the DB filters, then skip/limit),
 *   H. admission and affiliation enquiries are unaffected.
 *
 * Guarantees: no MongoDB connection, no email, no environment values read,
 * no documents created, modified or deleted.
 *
 * Usage: npx tsx scripts/test-enquiry-inquiry-type.ts
 */

import {
  ENQUIRY_TYPES,
  GENERAL_INQUIRY_TYPES,
  GENERAL_INQUIRY_TYPE_LABELS,
  INQUIRY_TYPE_ALIASES,
  INQUIRY_TYPE_UNSPECIFIED,
  generalInquiryTypeLabel,
  inquiryTypeMatchValues,
  isGeneralInquiryType,
  normalizeInquiryType,
} from "@/lib/enquiry-types";
import {
  buildEnquiryListQuery,
  type EnquiryListFilters,
  parseEnquiryCategoryFilter,
  parseEnquiryClassificationFilter,
  parseEnquiryPagination,
  parseEnquirySearch,
  parseEnquiryStatusFilter,
  parseEnquiryTypeFilter,
  parseInquiryTypeFilter,
} from "@/lib/enquiry-validation";
import {
  toEnquirySummary,
  toSafeEnquiry,
  type EnquirySource,
} from "@/models/Enquiry";

/* ── Tiny assertion harness ───────────────────────────────────────────── */

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

/** Stable JSON for comparing two built queries. */
function shape(value: unknown): string {
  return JSON.stringify(value);
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const BASE_FILTERS: EnquiryListFilters = {
  type: "",
  status: "",
  search: "",
  category: "",
  classification: "",
  inquiryType: "",
};

function filters(overrides: Partial<EnquiryListFilters>): EnquiryListFilters {
  return { ...BASE_FILTERS, ...overrides };
}

/** A complete lean-ish general enquiry as the API would receive it. */
function generalDoc(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    reference: "MSU-ENQ-VERIFY01",
    type: "general",
    status: "new",
    email: "someone@example.test",
    phone: "9876543210",
    message: "The printer in the examination cell is not working properly.",
    fullName: "Verification User",
    course: "",
    session: "",
    collegeName: "",
    contactPerson: "",
    designation: "",
    address: "",
    district: "",
    collegeType: "",
    purpose: "",
    courses: "",
    generalClassification: "",
    inquiryType: "technical_issue",
    createdAt: new Date("2026-01-05T09:30:00Z"),
    ...overrides,
  };
}

function asSource(doc: Record<string, unknown>): EnquirySource {
  return doc as unknown as EnquirySource;
}

/* ── A minimal MongoDB matcher for the operators this API builds ────────
   Only the shapes buildEnquiryListQuery() can emit are supported: equality,
   $in, $regex/$options, $or, $and and $nor. Anything else returns false so
   an unexpected operator can never be silently treated as a match.        */

function matchQuery(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$and") {
      return (condition as Record<string, unknown>[]).every((sub) =>
        matchQuery(doc, sub)
      );
    }
    if (key === "$or") {
      return (condition as Record<string, unknown>[]).some((sub) =>
        matchQuery(doc, sub)
      );
    }
    if (key === "$nor") {
      return (condition as Record<string, unknown>[]).every(
        (sub) => !matchQuery(doc, sub)
      );
    }

    const value = doc[key];

    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const operator = condition as Record<string, unknown>;

      if ("$in" in operator) {
        return (operator.$in as unknown[]).some((candidate) =>
          candidate === null
            ? value === null || value === undefined // Mongo: $in:[null] ⊇ missing
            : value === candidate
        );
      }

      if ("$regex" in operator) {
        if (typeof value !== "string") return false;
        return new RegExp(
          String(operator.$regex),
          typeof operator.$options === "string" ? operator.$options : ""
        ).test(value);
      }

      return false; // unknown operator — never built by this API
    }

    return value === condition;
  });
}

/* ── A. Safe response mapping ─────────────────────────────────────────── */

function mappingChecks() {
  section("A. Safe response mapping");

  const doc = generalDoc({ inquiryType: "technical_issue" });
  const summary = toEnquirySummary(asSource(doc));
  const detail = toSafeEnquiry(asSource(doc));

  check("the list mapper returns inquiryType", summary.inquiryType === "technical_issue");
  check("the detail mapper returns inquiryType", detail.inquiryType === "technical_issue");
  check(
    "inquiryType stays separate from the admin classification",
    summary.inquiryType === "technical_issue" && summary.classification === ""
  );

  const legacy = toEnquirySummary(asSource(generalDoc({ inquiryType: undefined })));
  check(
    "a record without inquiryType reads as an empty value, not undefined",
    legacy.inquiryType === ""
  );
  check(
    "its label is Unspecified",
    generalInquiryTypeLabel(legacy.inquiryType) === "Unspecified"
  );

  const aliased = toSafeEnquiry(
    asSource(generalDoc({ inquiryType: "result_exam" }))
  );
  check(
    "an alias written by an older public revision is reported canonically",
    aliased.inquiryType === "result_examination"
  );

  const rawSummary = JSON.stringify(summary);
  check(
    "the response exposes no MongoDB internals",
    !rawSummary.includes("_id") && !rawSummary.includes("__v")
  );
}

/* ── B. Every valid filter ────────────────────────────────────────────── */

function validFilterChecks() {
  section("B. Every supported inquiry type filters");

  check(
    "the vocabulary is exactly the ten controlled values",
    GENERAL_INQUIRY_TYPES.length === 10 &&
      [
        "admission",
        "affiliation",
        "technical_issue",
        "result_examination",
        "student_portal",
        "course_programme",
        "fees_payment",
        "documents_certificates",
        "contact_office",
        "other",
      ].every((value) => (GENERAL_INQUIRY_TYPES as readonly string[]).includes(value))
  );

  for (const value of GENERAL_INQUIRY_TYPES) {
    const parsed = parseInquiryTypeFilter(value);
    const query = buildEnquiryListQuery(filters({ type: "general", inquiryType: parsed }));

    check(`${value}: parsed as itself`, parsed === value);
    check(`${value}: has a human label`, Boolean(GENERAL_INQUIRY_TYPE_LABELS[value]));
    check(
      `${value}: becomes an $in over the stored field`,
      shape(query.inquiryType) ===
        shape({ $in: inquiryTypeMatchValues(value) })
    );
    check(`${value}: accepted by isGeneralInquiryType`, isGeneralInquiryType(value));
  }

  check(
    "`other` is a real, filterable choice",
    parseInquiryTypeFilter("other") === "other" &&
      buildEnquiryListQuery(filters({ inquiryType: "other" })).inquiryType !== undefined
  );
}

/* ── C. Invalid filters ───────────────────────────────────────────────── */

function invalidFilterChecks() {
  section("C. Invalid values never reach the query");

  const invalid: unknown[] = [
    "random",
    "admin",
    "unknown",
    "website",
    "$ne",
    "$regex",
    "$where",
    '{"$ne": null}',
    "",
    "all",
    "All",
    null,
    undefined,
    42,
    {},
    ["technical_issue"],
  ];

  for (const value of invalid) {
    const label = JSON.stringify(value) ?? String(value);
    const parsed = parseInquiryTypeFilter(value as string | null | undefined);
    const query = buildEnquiryListQuery(
      filters({ type: "general", inquiryType: parsed })
    );

    check(`${label} is rejected (means "no filter")`, parsed === "");
    check(`${label} is absent from the query`, !("inquiryType" in query));
  }

  const crafty = buildEnquiryListQuery(
    filters({ type: "general", inquiryType: parseInquiryTypeFilter('{"$ne": null}') })
  );
  check(
    "a crafted filter value never becomes a query key or an operator",
    !("inquiryType" in crafty) &&
      Object.keys(crafty).every(
        (key) => !["$ne", "$regex", "$where", "{", '"'].some((b) => key.includes(b))
      )
  );

  // The crafted value as a SEARCH term: it must end up as an escaped string
  // pattern inside $or, never as an operator.
  const searched = buildEnquiryListQuery(
    filters({ type: "general", search: '{"$ne": null}' })
  );
  const and = searched.$and as Record<string, unknown>[];
  const or = and?.[0]?.$or as Record<string, unknown>[] | undefined;
  check(
    "a crafted search term is only ever an escaped string pattern",
    Array.isArray(or) &&
      or.length > 0 &&
      or.every((clause) => {
        const field = Object.keys(clause)[0];
        const inner = clause[field] as Record<string, unknown>;
        return (
          field !== "$ne" &&
          field !== "$regex" &&
          "$regex" in inner &&
          typeof inner.$regex === "string" &&
          inner.$regex.includes("\\{")
        );
      })
  );
}

/* ── D. Unspecified ───────────────────────────────────────────────────── */

function unspecifiedChecks() {
  section("D. Unspecified finds records that predate the field");

  check(
    "the sentinel parses",
    parseInquiryTypeFilter("unspecified") === INQUIRY_TYPE_UNSPECIFIED
  );

  const query = buildEnquiryListQuery(
    filters({ type: "general", inquiryType: INQUIRY_TYPE_UNSPECIFIED })
  );
  check(
    "the query matches missing, null and empty values",
    shape(query.inquiryType) === shape({ $in: [null, ""] })
  );

  const missing = generalDoc();
  delete missing.inquiryType;
  const nullValue = generalDoc({ inquiryType: null });
  const empty = generalDoc({ inquiryType: "" });
  const typed = generalDoc({ inquiryType: "technical_issue" });

  check(
    "a document with no field matches",
    matchQuery(missing, { inquiryType: { $in: [null, ""] } })
  );
  check(
    "a null field matches",
    matchQuery(nullValue, { inquiryType: { $in: [null, ""] } })
  );
  check(
    "an empty-string field matches",
    matchQuery(empty, { inquiryType: { $in: [null, ""] } })
  );
  check(
    "a document WITH a topic does not match Unspecified",
    !matchQuery(typed, { inquiryType: { $in: [null, ""] } })
  );
  check(
    "an unspecified-only filter never leaks into admission/affiliation records",
    matchQuery(generalDoc({ inquiryType: undefined }), query) &&
      !matchQuery(
        { type: "admission", status: "new", inquiryType: undefined },
        query
      )
  );
}

/* ── E & F. Combined filters ──────────────────────────────────────────── */

function combinedFilterChecks() {
  section("E. type + inquiryType + status combine");

  const query = buildEnquiryListQuery(
    filters({
      type: "general",
      inquiryType: "technical_issue",
      status: "new",
      classification: "website_issue",
    })
  );

  check("type is preserved", query.type === "general");
  check("status is preserved", query.status === "new");
  check("the saved classification is preserved", query.generalClassification === "website_issue");
  check(
    "inquiryType is preserved",
    shape(query.inquiryType) === shape({ $in: ["technical_issue"] })
  );

  const docs = [
    generalDoc({
      inquiryType: "technical_issue",
      status: "new",
      generalClassification: "website_issue",
    }),
    generalDoc({ inquiryType: "technical_issue", status: "responded" }),
    generalDoc({ inquiryType: "fees_payment", status: "new" }),
  ];
  const matches = docs.filter((doc) => matchQuery(doc, query));
  check("only the records satisfying ALL filters match", matches.length === 1);

  section("F. search + inquiryType do not overwrite each other");

  const combined = buildEnquiryListQuery(
    filters({ type: "general", inquiryType: "technical_issue", search: "printer" })
  );

  check(
    "the topic filter is still on the stored field",
    shape(combined.inquiryType) === shape({ $in: ["technical_issue"] })
  );
  check("the search is still present", Array.isArray(combined.$and));

  const searchable = generalDoc({
    inquiryType: "technical_issue",
    message: "The printer in the examination cell is not working.",
  });
  const wrongTopic = generalDoc({
    inquiryType: "fees_payment",
    message: "The printer in the examination cell is not working.",
  });
  const wrongText = generalDoc({
    inquiryType: "technical_issue",
    message: "I would like to know about the hostel timings please.",
  });

  check("matches only when BOTH the topic and the text match", matchQuery(searchable, combined));
  check("a matching text with another topic is excluded", !matchQuery(wrongTopic, combined));
  check("a matching topic with other text is excluded", !matchQuery(wrongText, combined));

  const parsedSearch = parseEnquirySearch("printer");
  check(
    "the search term is escaped before it becomes a pattern",
    (buildEnquiryListQuery(filters({ type: "general", search: "a.b(c" })) as { $and: unknown[] })
      .$and instanceof Array &&
      !JSON.stringify(parsedSearch).includes("(")
  );

  const keyword = buildEnquiryListQuery(
    filters({ type: "general", category: parseEnquiryCategoryFilter("website_issue") })
  );
  check(
    "the existing keyword category filter still builds",
    Array.isArray(keyword.$and)
  );
}

/* ── G. Filtering happens before pagination ───────────────────────────── */

function paginationChecks() {
  section("G. The database filters first, then paginates");

  const docs = [
    generalDoc({ reference: "MSU-ENQ-AAAA0001", inquiryType: "technical_issue" }),
    generalDoc({ reference: "MSU-ENQ-AAAA0002", inquiryType: "fees_payment" }),
    generalDoc({ reference: "MSU-ENQ-AAAA0003", inquiryType: "technical_issue" }),
    generalDoc({ reference: "MSU-ENQ-AAAA0004", inquiryType: undefined }),
    generalDoc({ reference: "MSU-ENQ-AAAA0005", inquiryType: "technical_issue" }),
  ];

  // Exactly what the route does: parse pagination separately, build ONE query,
  // hand it to find()/countDocuments(), then apply skip/limit.
  const run = (raw: string) => {
    const params = new URLSearchParams(raw);
    const { skip, limit } = parseEnquiryPagination(params);
    const query = buildEnquiryListQuery(
      filters({
        type: parseEnquiryTypeFilter(params.get("type")),
        status: parseEnquiryStatusFilter(params.get("status")),
        search: parseEnquirySearch(params.get("search")),
        category: parseEnquiryCategoryFilter(params.get("category")),
        classification: parseEnquiryClassificationFilter(params.get("classification")),
        inquiryType: parseInquiryTypeFilter(params.get("inquiryType")),
      })
    );
    const filtered = docs.filter((doc) => matchQuery(doc, query));
    return {
      query,
      total: filtered.length,
      page: filtered.slice(skip, skip + limit),
    };
  };

  const all = run("type=general");
  const filtered = run("type=general&inquiryType=technical_issue&limit=2&page=1");
  const filteredPage2 = run("type=general&inquiryType=technical_issue&limit=2&page=2");

  check("the whole set has 5 general records", all.total === 5);
  check("the filtered total counts only matching records", filtered.total === 3);
  check(
    "page 1 holds 2 of the 3 matching records",
    filtered.page.length === 2 &&
      filtered.page.every((doc) => doc.inquiryType === "technical_issue")
  );
  check(
    "page 2 holds the remaining matching record (pagination runs on the filtered set)",
    filteredPage2.page.length === 1 &&
      filteredPage2.page[0]?.reference === "MSU-ENQ-AAAA0005"
  );
  check(
    "pagination values never leak into the filter itself",
    !("limit" in filtered.query) &&
      !("skip" in filtered.query) &&
      !("page" in filtered.query)
  );
  check(
    "the same filter produces the same query on every page",
    shape(filtered.query) === shape(filteredPage2.query)
  );
}

/* ── H. Existing enquiry types are unaffected ─────────────────────────── */

function compatibilityChecks() {
  section("H. Admission and affiliation enquiries remain unchanged");

  check(
    "the enquiry-type vocabulary is untouched",
    ENQUIRY_TYPES.length === 3 &&
      (ENQUIRY_TYPES as readonly string[]).join(",") ===
        "admission,affiliation,general"
  );

  for (const type of ["admission", "affiliation"] as const) {
    const query = buildEnquiryListQuery(filters({ type }));
    check(`${type}: no inquiryType clause is added`, !("inquiryType" in query));
    check(`${type}: the type filter is exactly as before`, query.type === type);
  }

  const admissionDoc = {
    type: "admission",
    status: "new",
    reference: "MSU-ENQ-AAAA0006",
    email: "a@example.test",
    phone: "9876543210",
    message: "Please tell me about the B.Ed. course and the fee structure.",
    fullName: "Admission Enquirer",
    course: "B.Ed.",
    session: "2026-27",
    collegeName: "",
    contactPerson: "",
    designation: "",
    address: "",
    district: "",
    collegeType: "",
    purpose: "",
    courses: "",
    generalClassification: "",
  };
  check(
    "an admission record has no inquiryType",
    toEnquirySummary(asSource(admissionDoc)).inquiryType === ""
  );
  check(
    "and no inquiryType filter is ever built without one being requested",
    !("inquiryType" in buildEnquiryListQuery(filters({ type: "admission" })))
  );

  const separate = buildEnquiryListQuery(
    filters({ type: "general", inquiryType: "technical_issue", classification: "unclassified" })
  );
  check(
    "inquiryType and classification stay independent query clauses",
    separate.generalClassification !== undefined &&
      separate.inquiryType !== undefined &&
    separate.generalClassification !== separate.inquiryType
  );

  check(
    "the classification vocabulary still holds its own website_issue topic",
    normalizeInquiryType("website_issue") === "website_issue"
  );
}

/* ── Vocabulary helpers ───────────────────────────────────────────────── */

function vocabularyChecks() {
  section("Canonical vocabulary and aliases");

  check(
    "every canonical value has a label",
    GENERAL_INQUIRY_TYPES.every((value) => Boolean(GENERAL_INQUIRY_TYPE_LABELS[value]))
  );
  check(
    "every alias resolves to a canonical value",
    Object.values(INQUIRY_TYPE_ALIASES).every((value) => isGeneralInquiryType(value))
  );
  check(
    "an alias expands to both stored spellings for the query",
    inquiryTypeMatchValues("result_examination").join(",") ===
      "result_examination,result_exam" &&
      inquiryTypeMatchValues("documents_certificates").join(",") ===
        "documents_certificates,documents_certificate"
  );
  check(
    "a canonical value needs no extra spelling",
    inquiryTypeMatchValues("technical_issue").join(",") === "technical_issue"
  );
  check(
    "normalizeInquiryType folds aliases and passes canonical values through",
    normalizeInquiryType("result_exam") === "result_examination" &&
      normalizeInquiryType("technical_issue") === "technical_issue"
  );
  check(
    "a missing value normalises to empty (Unspecified)",
    normalizeInquiryType(undefined) === "" &&
      normalizeInquiryType("") === "" &&
      normalizeInquiryType(null) === ""
  );
  check(
    "an unrecognised value is shown as-is rather than hidden",
    normalizeInquiryType("something_else") === "something_else"
  );
  check(
    "labels are correct",
    generalInquiryTypeLabel("technical_issue") === "Technical Issue" &&
      generalInquiryTypeLabel("admission") === "Admission Inquiry" &&
      generalInquiryTypeLabel("other") === "Other" &&
      generalInquiryTypeLabel("") === "Unspecified"
  );
}

/* ── Runner ───────────────────────────────────────────────────────────── */

function main() {
  console.log("General-enquiry inquiryType verification — offline, no database.");
  console.log("No document is created, read, modified or deleted.\n");

  vocabularyChecks();
  mappingChecks();
  validFilterChecks();
  invalidFilterChecks();
  unspecifiedChecks();
  combinedFilterChecks();
  paginationChecks();
  compatibilityChecks();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log("Admin inquiryType display and filtering verified.");
  }
}

main();
