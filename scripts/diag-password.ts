/**
 * SAFE DIAGNOSTIC — verifies password matching without exposing the password.
 * Tests if the ADMIN_PASSWORD from env matches any stored admin hash.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import bcrypt from "bcrypt";

/** bcrypt hashes look like $2a$/$2b$/$2y$ followed by the cost and salt. */
function isBcryptHash(value: unknown): value is string {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function diagnose() {
  const uri = process.env.MONGODB_URI;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!uri) { console.error("MONGODB_URI not set."); process.exit(1); }
  if (!adminPassword) { console.error("ADMIN_PASSWORD not set."); process.exit(1); }
  if (!adminEmail) { console.error("ADMIN_EMAIL not set."); process.exit(1); }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Database: ${db?.databaseName}`);

  const admin = await db!.collection("admins").findOne({ email: adminEmail.toLowerCase() });
  if (!admin) {
    console.log(`Admin "${adminEmail}" not found.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`Admin: ${admin.email} (${admin.name})`);
  console.log(`Status: ${admin.status}`);
  console.log(`Has password: ${!!admin.password}`);

  // Only bcrypt-protected records can be compared here. Normal admins store
  // reversible AES-256-GCM ciphertext (see lib/password.ts) which bcrypt cannot
  // read — use the Admin Management UI to reveal those instead.
  if (!isBcryptHash(admin.password)) {
    console.log("\nStored password is not a bcrypt hash (AES-256-GCM encrypted).");
    console.log("This diagnostic cannot compare it — reveal it from Admin Management.");
    await mongoose.disconnect();
    return;
  }

  // Test password match
  const matches = await bcrypt.compare(adminPassword, admin.password);
  console.log(`\nADMIN_PASSWORD from .env.local matches stored hash: ${matches}`);
  
  if (!matches) {
    console.log("\nThe password in your .env.local ADMIN_PASSWORD does NOT match");
    console.log("the stored bcrypt hash in msu.admins.");
    console.log("");
    console.log("This means the admin was created with a DIFFERENT password.");
    console.log("You need to run create-admin.ts with the correct password.");
  }

  // Also check the other admin
  const allAdmins = await db!.collection("admins").find({}).toArray();
  for (const a of allAdmins) {
    if (!isBcryptHash(a.password)) {
      console.log(`\n  ${a.email}: AES-256-GCM encrypted (bcrypt not applicable)`);
      continue;
    }
    const m = await bcrypt.compare(adminPassword, a.password);
    console.log(`\n  ${a.email}: password match = ${m}`);
  }

  await mongoose.disconnect();
}

diagnose().catch((err) => {
  console.error("Diagnosis failed:", err.message);
  process.exit(1);
});
