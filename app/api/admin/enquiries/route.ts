import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Enquiry, { toEnquirySummary, type EnquirySource } from "@/models/Enquiry";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  buildEnquiryListQuery,
  parseEnquiryCategoryFilter,
  parseEnquiryClassificationFilter,
  parseEnquiryPagination,
  parseEnquirySearch,
  parseEnquiryStatusFilter,
  parseEnquiryTypeFilter,
  parseInquiryTypeFilter,
} from "@/lib/enquiry-validation";

/**
 * GET /api/admin/enquiries
 *
 * Paginated list of the enquiries created by the PUBLIC MSU project.
 *
 * Query params:
 *   search         — matched against reference, email, phone, fullName,
 *                    contactPerson and collegeName; for GENERAL enquiries only,
 *                    the free-text message is searched too
 *   type           — "admission" | "affiliation" | "general" (anything else = no filter)
 *   status         — "new" | "in_review" | "responded" | "closed" (anything else = no filter)
 *   category       — a KEYWORD search category (see @/lib/enquiry-categories).
 *                    Query-time only; never changes a stored enquiry. The
 *                    "other" category selects enquiries matching no keyword.
 *   classification — a SAVED admin classification slug, or "unclassified" for
 *                    general enquiries with no saved classification
 *   inquiryType    — the PUBLIC submitter's chosen topic for a general
 *                    enquiry (admission, technical_issue, fees_payment, …),
 *                    or "unspecified" for records written before the field
 *                    existed. Read from the STORED field, never from the
 *                    message text, and combined with every filter above.
 *   page           — 1-based, defaults to 1
 *   limit          — defaults to 20, capped at 100
 *
 * The `category` and `classification` filters are separate concepts: the first
 * is a keyword search, the second reads the value an admin explicitly saved.
 *
 * RESPONSE IS DELIBERATELY MINIMAL: each row carries the reference, type,
 * status, submitted timestamp and only enough identifying context to tell one
 * enquiry from another (a masked email plus a name/organisation). The full
 * email, phone, address and message are returned only by the single-enquiry
 * endpoint, so a list screen can never dump bulk PII.
 *
 * Authentication: any active admin (authenticateAdmin).
 * Rate limited: 60 requests / 15 min per client.
 *
 * Invalid pagination values fall back to defaults — `?page=abc` must never
 * become a 500.
 */
const adminEnquiryLimiter = createRateLimiter({
  name: "admin-enquiries",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminEnquiryLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const url = new URL(req.url);

    const { page, limit, skip } = parseEnquiryPagination(url.searchParams);

    // EVERY filter is parsed against an allow-list before it is used: raw
    // request text never becomes a field name, a value or an operator.
    const filters = {
      type: parseEnquiryTypeFilter(url.searchParams.get("type")),
      status: parseEnquiryStatusFilter(url.searchParams.get("status")),
      search: parseEnquirySearch(url.searchParams.get("search")),
      category: parseEnquiryCategoryFilter(url.searchParams.get("category")),
      classification: parseEnquiryClassificationFilter(
        url.searchParams.get("classification")
      ),
      inquiryType: parseInquiryTypeFilter(url.searchParams.get("inquiryType")),
    };

    // The single source of the MongoDB filter. It is built BEFORE pagination,
    // so skip/limit always operate on the whole filtered set — not on whatever
    // happens to be loaded in the browser.
    const query = buildEnquiryListQuery(filters);

    const [enquiries, total] = await Promise.all([
      Enquiry.find(query)
        // `_id` tie-break keeps page boundaries stable for enquiries created in
        // the same instant (each page is a separate query).
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Enquiry.countDocuments(query),
    ]);

    return NextResponse.json({
      success: true,
      data: enquiries.map((enquiry) =>
        toEnquirySummary(enquiry as unknown as EnquirySource)
      ),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Admin enquiries list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load enquiries." },
      { status: 500 }
    );
  }
}
