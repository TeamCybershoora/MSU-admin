import mongoose, { Schema, type Document } from "mongoose";

/**
 * Counter — one document per identifier sequence (Phase 5).
 *
 * Namespaces (see @/lib/enrollment):
 *   _id = "enrollment"                 → the single global enrollment sequence
 *   _id = "university-roll:<year>"     → one independent sequence per admission year
 *
 * Semantics of `nextValue`
 * ------------------------
 * `nextValue` holds the LAST sequence value already allocated for that
 * namespace (0 / absent = nothing allocated yet). An allocation is a single
 * atomic `$inc` which returns the newly allocated value:
 *
 *   Counter.findOneAndUpdate(
 *     { _id: key },
 *     { $inc: { nextValue: 1 } },
 *     { upsert: true, new: true, session }
 *   )                                            // → nextValue = allocated value
 *
 * The first allocation in a fresh namespace therefore returns 1 (formatted as
 * EN00000001 / MSU<year>000001) and the sequences are independent: nothing in
 * this model derives a value from document counts, timestamps, randomness, a
 * maximum scan, or a value supplied by a caller.
 *
 * The counter is only ever advanced inside the enrollment transaction, so a
 * failed or aborted enrollment rolls the increment back and no value is
 * consumed. Identifiers of deleted students are never re-issued (the counter
 * only moves forward).
 *
 * `_id` is a String (not an ObjectId) so the namespace key is readable in the
 * database. No additional indexes are declared.
 */

export interface ICounter extends Document<string> {
  _id: string;
  /** Last allocated sequence value for this namespace (0 = none yet). */
  nextValue: number;
  createdAt: Date;
  updatedAt: Date;
}

const counterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    nextValue: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Reuse existing model if it exists (avoids OverwriteModelError in dev HMR)
const Counter =
  mongoose.models.Counter || mongoose.model<ICounter>("Counter", counterSchema);

export default Counter;
