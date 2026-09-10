// Example seed script — replace with your real finance model export.
// Run with: npm run seed
import { getDb, closeDb } from "./db.js";

const sampleRevenue = [
  { quarter: "Q1-2026", department: "Sales", revenue: 120000, cogs: 45000 },
  { quarter: "Q1-2026", department: "Marketing", revenue: 30000, cogs: 8000 },
  { quarter: "Q2-2026", department: "Sales", revenue: 140000, cogs: 50000 },
  { quarter: "Q2-2026", department: "Marketing", revenue: 32000, cogs: 9000 },
];

const sampleAssumptions = [
  { key: "growth_rate", value: 0.08, note: "Assumed QoQ revenue growth" },
  { key: "discount_rate", value: 0.1, note: "Used for DCF valuation" },
];

async function seed() {
  const db = await getDb();

  await db.collection("revenue").deleteMany({});
  await db.collection("revenue").insertMany(sampleRevenue);

  await db.collection("assumptions").deleteMany({});
  await db.collection("assumptions").insertMany(sampleAssumptions);

  console.log("Seeded 'revenue' and 'assumptions' collections.");
  await closeDb();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
