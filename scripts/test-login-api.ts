/**
 * Tests the running admin login API using the actual password from .env.local.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BASE = "http://localhost:3099";
const email = process.env.ADMIN_EMAIL!;
const password = process.env.ADMIN_PASSWORD!;

async function main() {
  console.log(`Testing login with email: ${email}`);
  console.log(`Password length: ${password.length}`);
  
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  
  const data = await res.json();
  console.log(`\nResponse status: ${res.status}`);
  console.log(`Success: ${data.success}`);
  console.log(`Message: ${data.message}`);
  
  if (data.success && data.token) {
    console.log(`Token: ${data.token.substring(0, 30)}...`);
    console.log(`Admin: ${data.admin?.name} (${data.admin?.email})`);
    
    // Test colleges API with the token
    console.log("\n--- Testing colleges API ---");
    const collegeRes = await fetch(`${BASE}/api/admin/colleges?page=1&limit=5`, {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    const collegeData = await collegeRes.json();
    console.log(`Status: ${collegeRes.status}`);
    console.log(`Success: ${collegeData.success}`);
    console.log(`Total colleges: ${collegeData.pagination?.total}`);
    console.log(`First 3: ${(collegeData.data || []).slice(0, 3).map((c: { collegeName?: string }) => c.collegeName).join(", ")}`);
  }
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
