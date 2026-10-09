/**
 * Spotlight API — admin management of the homepage "Campus in the spotlight"
 * gallery.
 *
 * Endpoints:
 *   GET    /api/admin/spotlight  — list every item (active + inactive)
 *   POST   /api/admin/spotlight  — create an item from an uploaded image id
 *   PUT    /api/admin/spotlight  — update metadata / replace the image
 *   DELETE /api/admin/spotlight  — delete an item and its stored image
 *
 * All endpoints require admin JWT authentication (authenticateAdmin) and are
 * rate limited.
 *
 * Storage: an item stores only a GridFS id (uploaded separately through
 * POST /api/admin/images/upload). Replacing or deleting an item removes the
 * superseded GridFS file so no orphaned bytes remain.
 *
 * Security:
 * - Every mutation is authorized server-side; the UI is never trusted.
 * - `imageId` must be a well-formed ObjectId — arbitrary values never reach
 *   the database or the storage layer.
 * - Responses expose only the public-safe shape (toSafeSpotlight).
 */
import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Spotlight, { toSafeSpotlight } from "@/models/Spotlight";
import { deleteImage, isImageId } from "@/lib/image-storage";
import { authenticateAdmin } from "@/lib/admin-auth";
import { createRateLimiter } from "@/lib/rate-limit";

const adminSpotlightLimiter = createRateLimiter({
  name: "admin-spotlight",
  windowMs: 15 * 60 * 1000,
  limit: 60,
});

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

  if (adminSpotlightLimiter.check(req)) {
    return NextResponse.json(
      { success: false, message: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    await connectDB();

    const items = await Spotlight.find({})
      .sort({ displayOrder: 1, createdAt: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      data: items.map((item) =>
        toSafeSpotlight(item as unknown as Parameters<typeof toSafeSpotlight>[0])
      ),
    });
  } catch (error) {
    console.error("Admin spotlight list error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to load spotlight items." },
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
    const { imageId, imageName, altText, displayOrder, isActive } = body;

    if (typeof imageId !== "string" || !isImageId(imageId.trim())) {
      return NextResponse.json(
        { success: false, message: "A valid uploaded image is required." },
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

    const item = await Spotlight.create({
      imageId: imageId.trim(),
      imageName: typeof imageName === "string" ? imageName.trim() : "",
      altText: altText.trim(),
      displayOrder: order,
      isActive: isActive === undefined ? true : Boolean(isActive),
    });

    return NextResponse.json({
      success: true,
      message: "Spotlight item created successfully.",
      item: toSafeSpotlight(item),
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

    console.error("Admin spotlight create error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to create spotlight item." },
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
    const { id, imageId, imageName, altText, displayOrder, isActive } = body;

    if (typeof id !== "string" || !id.trim()) {
      return NextResponse.json(
        { success: false, message: "Spotlight item id is required." },
        { status: 400 }
      );
    }

    const item = await Spotlight.findById(id);
    if (!item) {
      return NextResponse.json(
        { success: false, message: "Spotlight item not found." },
        { status: 404 }
      );
    }

    const previousImageId = item.imageId;

    if (imageId !== undefined) {
      if (typeof imageId !== "string" || !isImageId(imageId.trim())) {
        return NextResponse.json(
          { success: false, message: "A valid uploaded image is required." },
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

    // The image was replaced — drop the superseded bytes.
    if (item.imageId !== previousImageId) {
      await deleteImage(previousImageId);
    }

    return NextResponse.json({
      success: true,
      message: "Spotlight item updated successfully.",
      item: toSafeSpotlight(item),
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

    console.error("Admin spotlight update error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to update spotlight item." },
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
        { success: false, message: "Spotlight item id is required." },
        { status: 400 }
      );
    }

    const item = await Spotlight.findByIdAndDelete(id);
    if (!item) {
      return NextResponse.json(
        { success: false, message: "Spotlight item not found." },
        { status: 404 }
      );
    }

    // Remove the stored bytes together with the record.
    await deleteImage(item.imageId);

    return NextResponse.json({
      success: true,
      message: "Spotlight item deleted successfully.",
    });
  } catch (error) {
    console.error("Admin spotlight delete error:", error);
    return NextResponse.json(
      { success: false, message: "Unable to delete spotlight item." },
      { status: 500 }
    );
  }
}
