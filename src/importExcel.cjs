const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { MongoClient } = require("mongodb");

require("dotenv").config();

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB || "finance_model";

// NEW workbook
const excelPath = path.join(__dirname, "..", "Test_POC.xlsx");

// Sheet → Collection mapping
const sheetMapping = {
  "01_Client_Master": "client_master",
  "02_Financial_Actuals": "financial_actuals",
  "03_Volume_Metrics": "volume_metrics",
  "04_Rebate_Economics": "rebate_economics",
  "05_Profitability_Summary": "profitability_summary",
  "07_Data_Dictionary": "data_dictionary",
  "08_Business_Rules": "business_rules",
  "10_Validation_Results": "validation_results"
};

async function main() {
  if (!fs.existsSync(excelPath)) {
    throw new Error(`Excel file not found: ${excelPath}`);
  }

  console.log("Reading Test_POC.xlsx...");
  const workbook = XLSX.readFile(excelPath);

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db(dbName);

    for (const [sheetName, collectionName] of Object.entries(sheetMapping)) {

      if (!workbook.SheetNames.includes(sheetName)) {
        console.log(`Skipping missing sheet: ${sheetName}`);
        continue;
      }

      const worksheet = workbook.Sheets[sheetName];

      const documents = XLSX.utils.sheet_to_json(worksheet, {
        defval: null
      });

      console.log(`${sheetName}: ${documents.length} records`);

      const collection = db.collection(collectionName);

      await collection.deleteMany({});

      if (documents.length > 0) {
        await collection.insertMany(documents);
      }

      console.log(`Imported ${documents.length} records into ${collectionName}`);
    }

    console.log("\n====================================");
    console.log("POC Excel import completed successfully!");
    console.log(`Database: ${dbName}`);
    console.log("====================================");

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("\nIMPORT FAILED");
  console.error(err);
  process.exit(1);
});