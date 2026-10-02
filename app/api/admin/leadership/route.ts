/**
 * Leadership API — admin management of the FIXED university leadership
 * positions (Chancellor, Vice Chancellor).
 *
 * Endpoints:
 *   GET    /api/admin/leadership  — list every record (active + inactive)
 *   POST   /api/admin/leadership  — create the single record for a fixed role
 *   PUT    /api/admin/leadership  — update details / replace the photograph
 *   DELETE /api/admin/leadership  — delete a record and its stored image
 *
 * Restore Default lives in the sibling route /restore (it must not trust a
 * browser-supplied default object).
 *
 * All endpoints require admin JWT authentication (authenticateAdmin) and are
 * rate limited.
 *
 * Storage: a record stores only a GridFS id (uploaded through the shared
 * POST /api/admin/images/upload). Replacing or deleting a record removes the
 * superseded image so no orphaned bytes remain.
 *
 * Security:
 * - Every mutation is authorized server-side; the UI is never trusted.
 * - `role` is restricted to LEADERSHIP_ROLES (the fixed positions); any other
 *   value is rejected. At most ONE record may exist per role, so there can
 *   never be two active Chancellors.
 * - There is no admin-managed profile URL/route of any kind.
 * - `imageId` must be a well-formed ObjectId; responses expose only the
 *   public-safe shape (toSafeLeadership).
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Leadership, { toSafeLeadership } from "@/models/Leadership";
import { LEADERSHIP_ROLES, type LeadershipRole } from "@/lib/leadership";
import { deleteImage, isImageId } from "@/lib/image-storage";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";

const adminLeadershipLimiter = createRateLimiter({
  name: "admin-leadership",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

function parseRole(value: unknown): LeadershipRole | null {
  return typeof value === "string" &&
    (LEADERSHIP_ROLES as readonly string[]).includes(value)
    ? (value as LeadershipRole)
    : null;
}

/** Parse an optional display-order value into a non-negative integer. */
function parseDisplayOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  if (adminLeadershipLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const items = await Leadership.find({})
      .sort({ displayOrder: 1, createdAt: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: items.map((item) =>
        toSafeLeadership(item as unknown as Parameters<typeof toSafeLeadership>[0])
      ),
    });
  } catch (error) {
    console.error("Admin leadership list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load leadership records." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { role, name, designation, description, imageId, imageName, altText, displayOrder, isActive } = body;

    const parsedRole = parseRole(role);
    if (!parsedRole) {
      return NextResponse.json(
        { success: false, message: "A valid fixed role is required." },
        { status: 400 }
      );
    }

    // Positions are fixed: only one record may exist per role.
    const existing = await Leadership.findOne({ role: parsedRole }).lean();
    if (existing) {
      return NextResponse.json(
        {
          success: false,
          message:
            "A record for this position already exists. Edit it instead of creating another.",
        },
        { status: 409 }
      );
    }

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { success: false, message: "Name is required." },
        { status: 400 }
      );
    }

    if (typeof designation !== "string" || !designation.trim()) {
      return NextResponse.json(
        { success: false, message: "Designation is required." },
        { status: 400 }
      );
    }

    if (typeof imageId !== "string" || !isImageId(imageId.trim())) {
      return NextResponse.json(
        { success: false, message: "A valid uploaded photograph is required." },
        { status: 400 }
      );
    }

    if (typeof altText !== "string" || !altText.trim()) {
      return NextResponse.json(
        { success: false, message: "Alt text is required." },
        { status: 400 }
      );
    }

    const order = parseDisplayOrder(displayOrder);
    if (order === null) {
      return NextResponse.json(
        { success: false, message: "Display order must be zero or greater." },
        { status: 400 }
      );
    }

    const item = await Leadership.create({
      role: parsedRole,
      name: name.trim(),
      designation: designation.trim(),
      description: typeof description === "string" ? description.trim() : "",
      imageId: imageId.trim(),
      imageName: typeof imageName === "string" ? imageName.trim() : "",
      altText: altText.trim(),
      displayOrder: order,
      isActive: isActive === undefined ? true : Boolean(isActive),
    });

    return NextResponse.json({
      success: true,
      message: "Leadership record created successfully.",
      item: toSafeLeadership(item),
    });
  } catch (error: unknown) {
    const err = error as { name?: string; errors?: Record<string, { message: string }> };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin leadership create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create leadership record." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { id, name, designation, description, imageId, imageName, altText, displayOrder, isActive } = body;

    if (typeof id !== "string" || !id.trim()) {
      return NextResponse.json(
        { success: false, message: "Leadership record id is required." },
        { status: 400 }
      );
    }

    const item = await Leadership.findById(id);
    if (!item) {
      return NextResponse.json(
        { success: false, message: "Leadership record not found." },
        { status: 404 }
      );
    }

    const previousImageId = item.imageId;

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return NextResponse.json(
          { success: false, message: "Name cannot be empty." },
          { status: 400 }
        );
      }
      item.name = name.trim();
    }

    if (designation !== undefined) {
      if (typeof designation !== "string" || !designation.trim()) {
        return NextResponse.json(
          { success: false, message: "Designation cannot be empty." },
          { status: 400 }
        );
      }
      item.designation = designation.trim();
    }

    if (description !== undefined) {
      item.description = typeof description === "string" ? description.trim() : "";
    }

    if (imageId !== undefined) {
      if (typeof imageId !== "string" || !isImageId(imageId.trim())) {
        return NextResponse.json(
          { success: false, message: "A valid uploaded photograph is required." },
          { status: 400 }
        );
      }
      item.imageId = imageId.trim();
    }

    if (imageName !== undefined) {
      item.imageName = typeof imageName === "string" ? imageName.trim() : "";
    }

    if (altText !== undefined) {
      if (typeof altText !== "string" || !altText.trim()) {
        return NextResponse.json(
          { success: false, message: "Alt text cannot be empty." },
          { status: 400 }
        );
      }
      item.altText = altText.trim();
    }

    if (displayOrder !== undefined) {
      const order = parseDisplayOrder(displayOrder);
      if (order === null) {
        return NextResponse.json(
          { success: false, message: "Display order must be zero or greater." },
          { status: 400 }
        );
      }
      item.displayOrder = order;
    }

    if (isActive !== undefined) {
      item.isActive = Boolean(isActive);
    }

    await item.save();

    // The photograph was replaced — drop the superseded bytes.
    if (item.imageId !== previousImageId) {
      await deleteImage(previousImageId);
    }

    return NextResponse.json({
      success: true,
      message: "Leadership record updated successfully.",
      item: toSafeLeadership(item),
    });
  } catch (error: unknown) {
    const err = error as { name?: string; errors?: Record<string, { message: string }> };

    if (err.name === "ValidationError" && err.errors) {
      const messages = Object.values(err.errors).map((e) => e.message);
      return NextResponse.json(
        { success: false, message: messages.join(" ") },
        { status: 400 }
      );
    }

    console.error("Admin leadership update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update leadership record." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const auth = await authenticateAdmin(req);
  if ("error" in auth) return auth.error;

  try {
    await connectDB();

    const body = await req.json();
    const { id } = body;

    if (typeof id !== "string" || !id.trim()) {
      return NextResponse.json(
        { success: false, message: "Leadership record id is required." },
        { status: 400 }
      );
    }

    const item = await Leadership.findByIdAndDelete(id);
    if (!item) {
      return NextResponse.json(
        { success: false, message: "Leadership record not found." },
        { status: 404 }
      );
    }

    // Remove the stored photograph together with the record.
    await deleteImage(item.imageId);

    return NextResponse.json({
      success: true,
      message: "Leadership record deleted successfully.",
    });
  } catch (error) {
    console.error("Admin leadership delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete leadership record." },
      { status: 500 }
    );
  }
}
