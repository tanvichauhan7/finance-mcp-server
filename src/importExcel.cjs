const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { MongoClient } = require("mongodb");

require("dotenv").config();

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "finance_model";

const excelPath = path.join(__dirname, "..", "NovaTech_Finance_Model.xlsx");

const collections = [
  "Revenue",
  "Expenses",
  "Headcount",
  "Assumptions",
  "Budgets"
];

async function main() {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`Excel file not found: ${excelPath}`);
  }

  console.log("Reading Excel file...");
  const workbook = XLSX.readFile(excelPath);

  const client = new MongoClient(uri);

  try {
    await client.connect();

    const db = client.db(dbName);

    for (const sheetName of collections) {
      if (!workbook.SheetNames.includes(sheetName)) {
        console.log(`Skipping missing sheet: ${sheetName}`);
        continue;
      }

      const collectionName = sheetName.toLowerCase();

      const worksheet = workbook.Sheets[sheetName];

      const documents = XLSX.utils.sheet_to_json(worksheet, {
        defval: null
      });

      console.log(
        `${sheetName}: ${documents.length} records`
      );

      const collection = db.collection(collectionName);

      // Remove old data from this collection
      await collection.deleteMany({});

      // Insert new Excel data
      if (documents.length > 0) {
        await collection.insertMany(documents);
      }

      console.log(
        `Imported ${documents.length} records into ${collectionName}`
      );
    }

    console.log("");
    console.log("====================================");
    console.log("Excel import completed successfully!");
    console.log(`Database: ${dbName}`);
    console.log("====================================");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("");
  console.error("IMPORT FAILED");
  console.error(error);
  process.exit(1);
});