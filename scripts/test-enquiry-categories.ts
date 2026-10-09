/**
 * Offline verification of the general-enquiry category and classification
 * vocabulary (lib/enquiry-categories.ts) and the query-string parsing that
 * feeds the General Enquiries list API.
 *
 * Runs entirely in memory: it never connects to MongoDB, never sends email and
 * never reads an environment value.
 *
 * Usage: npx tsx scripts/test-enquiry-categories.ts
 */
import {
  ENQUIRY_CATEGORIES,
  ENQUIRY_CATEGORY_MATCH_FIELDS,
  GENERAL_CLASSIFICATIONS,
  GENERAL_CLASSIFICATION_LABELS,
  GENERAL_UNCLASSIFIED,
  allCategoryKeywordPattern,
  categoryKeywordPattern,
  generalClassificationLabel,
  isEnquiryCategoryKey,
  isGeneralClassification,
} from "@/lib/enquiry-categories";
import {
  GENERAL_ENQUIRY_EXTRA_SEARCH_FIELDS,
  parseEnquiryCategoryFilter,
  parseEnquiryClassificationFilter,
  validateClassificationInput,
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

/* ── Classification vocabulary ──────────────────────────────── */

section("Classification values");

check(
  "the classification slugs are stable and complete",
  GENERAL_CLASSIFICATIONS.join(",") ===
    "admission,affiliation,website_issue,result_exam,student_portal," +
      "course_programme,fees_payment,documents_certificate,contact_office," +
      "technical_issue,other"
);
check(
  "every classification has a human label",
  GENERAL_CLASSIFICATIONS.every(
    (value) => typeof GENERAL_CLASSIFICATION_LABELS[value] === "string"
  )
);
check(
  "the type guard accepts real slugs and rejects anything else",
  isGeneralClassification("website_issue") &&
    !isGeneralClassification("website") &&
    !isGeneralClassification("") &&
    !isGeneralClassification(null)
);
check(
  "unclassified is the empty string",
  GENERAL_UNCLASSIFIED === "" &&
    generalClassificationLabel(GENERAL_UNCLASSIFIED) === "Unclassified" &&
    generalClassificationLabel(null) === "Unclassified"
);
check(
  "a stored slug renders its label",
  generalClassificationLabel("result_exam") === "Result / Examination"
);

/* ── Category keyword mapping ───────────────────────────────── */

section("Category keyword mapping (search filters, not classification)");

check(
  "category keys match the classification slugs",
  ENQUIRY_CATEGORIES.map((category) => category.key).join(",") ===
    GENERAL_CLASSIFICATIONS.join(",")
);
check(
  "every category is a valid category key",
  ENQUIRY_CATEGORIES.every((category) => isEnquiryCategoryKey(category.key))
);
check(
  "the admission category carries MSU admission keywords",
  categoryKeywordPattern("admission").includes("admission") &&
    categoryKeywordPattern("admission").includes("eligibility")
);
check(
  "the affiliation category is worded as college registration/affiliation",
  categoryKeywordPattern("affiliation").includes("college registration") &&
    categoryKeywordPattern("affiliation").includes("affiliation process")
);
check(
  "the website category covers links and loading problems",
  ["website", "broken link", "not loading"].every((keyword) =>
    categoryKeywordPattern("website_issue").includes(keyword)
  )
);
check(
  "the result/exam category covers results and marksheets",
  categoryKeywordPattern("result_exam").includes("marksheet") &&
    categoryKeywordPattern("result_exam").includes("result portal")
);
check(
  "the student/portal category covers portal login",
  categoryKeywordPattern("student_portal").includes("student portal") &&
    categoryKeywordPattern("student_portal").includes("password")
);
check(
  "\"other\" carries no keywords of its own",
  categoryKeywordPattern("other") === ""
);
check(
  "allCategoryKeywordPattern unions every keyword of every category",
  (() => {
    // Compared by branch count rather than raw text, because keywords with
    // regex metacharacters (e.g. "B.Ed") are escaped in the pattern.
    const total = ENQUIRY_CATEGORIES.flatMap(
      (category) => category.keywords
    ).filter((keyword) => keyword.trim().length > 0).length;
    return allCategoryKeywordPattern().split("|").length === total;
  })()
);

section("Keyword patterns are safe");

check(
  "keyword matching is whole-word (not a substring free-for-all)",
  categoryKeywordPattern("admission").includes("\\badmission\\b")
);
check(
  "regex metacharacters in a keyword are escaped",
  categoryKeywordPattern("course_programme").includes("B\\.Ed")
);
check(
  "no raw user input can become a pattern (only stored keywords are used)",
  !/\$\{/.test(categoryKeywordPattern("admission")) &&
    !/[?+*]{2,}/.test(categoryKeywordPattern("admission"))
);

section("Category match fields");

check(
  "the content fields include the free-text message and typical identity fields",
  ENQUIRY_CATEGORY_MATCH_FIELDS.includes("message") &&
    ENQUIRY_CATEGORY_MATCH_FIELDS.includes("fullName") &&
    ENQUIRY_CATEGORY_MATCH_FIELDS.includes("collegeName")
);

/* ── Filter parsing ─────────────────────────────────────────── */

section("Category filter parsing");

check("a known category filters", parseEnquiryCategoryFilter("admission") === "admission");
check("other is a real category", parseEnquiryCategoryFilter("other") === "other");
check("an unknown category means no filter", parseEnquiryCategoryFilter("grades") === "");
check("All means no filter", parseEnquiryCategoryFilter("All") === "");
check("an absent category means no filter", parseEnquiryCategoryFilter(null) === "");

section("Classification filter parsing (saved value, not keywords)");

check(
  "a saved slug filters",
  parseEnquiryClassificationFilter("website_issue") === "website_issue"
);
check(
  "unclassified is a distinct filter",
  parseEnquiryClassificationFilter("unclassified") === "unclassified"
);
check("an unknown value means no filter", parseEnquiryClassificationFilter("spam") === "");
check("All means no filter", parseEnquiryClassificationFilter("All") === "");

/* ── Classification update validation ───────────────────────── */

section("Classification update validation (server-side allow-list)");

check("an allowed slug is accepted", (() => {
  const r = validateClassificationInput("fees_payment");
  return r.ok && r.value === "fees_payment";
})());
check("an empty string clears the classification", (() => {
  const r = validateClassificationInput("");
  return r.ok && r.value === "";
})());
check("whitespace around a slug is tolerated", (() => {
  const r = validateClassificationInput("  other  ");
  return r.ok && r.value === "other";
})());
check("an invented value is rejected", !validateClassificationInput("priority").ok);
check("a non-string is rejected", !validateClassificationInput(42).ok);
check("null is rejected", !validateClassificationInput(null).ok);
check(
  "every listed classification is accepted",
  GENERAL_CLASSIFICATIONS.every((value) => validateClassificationInput(value).ok)
);

/* ── General search fields ──────────────────────────────────── */

section("General search includes the message");

check(
  "general enquiries search the free-text message",
  GENERAL_ENQUIRY_EXTRA_SEARCH_FIELDS.includes("message")
);

/* ── Summary ────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All general enquiry category checks passed.");
}
