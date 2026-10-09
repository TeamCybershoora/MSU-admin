/**
 * One-time Admin seed script.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret123 npx tsx scripts/create-admin.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import bcrypt from "bcrypt";
import connectDB from "@/lib/mongodb";
import Admin from "@/models/Admin";

const SALT_ROUNDS = 10;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`Error: ${name} is not defined in the environment.`);
    console.error(`Set it in your .env.local file or export it before running this script.`);
    process.exit(1);
  }
  return value.trim();
}

async function main(): Promise<void> {
  console.log("Creating admin...");

  const email = getRequiredEnv("ADMIN_EMAIL").toLowerCase();
  const password = getRequiredEnv("ADMIN_PASSWORD");

  if (password.length < 8) {
    console.error("Error: ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  await connectDB();

  const existingAdmin = await Admin.findOne({ email });
  if (existingAdmin) {
    console.log("Admin already exists.");
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  await Admin.create({
    name: "Admin",
    email,
    password: passwordHash,
    role: "admin",
    status: "active",
  });

  console.log("Admin account created successfully.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to create admin:", error);
  process.exit(1);
});
