const { execSync } = require("child_process");
const fs = require("fs");

console.log("");
console.log("========================================");
console.log("   NovaTech Finance MCP Setup");
console.log("========================================");
console.log("");

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: "inherit" });
}

try {
  // Check Excel model
  if (!fs.existsSync("NovaTech_Finance_Model.xlsx")) {
    throw new Error(
      "NovaTech_Finance_Model.xlsx was not found in the project folder."
    );
  }

  console.log("✓ Excel finance model found");

  // Import Excel into MongoDB
  run("node src/importExcel.cjs");

  console.log("");
  console.log("========================================");
  console.log("   SETUP COMPLETE");
  console.log("========================================");
  console.log("");
  console.log("Database: finance_model");
  console.log("Collections:");
  console.log("  - revenue");
  console.log("  - expenses");
  console.log("  - headcount");
  console.log("  - assumptions");
  console.log("  - budgets");
  console.log("");
  console.log("Your Finance MCP Server is ready.");
  console.log("");

} catch (error) {
  console.error("");
  console.error("========================================");
  console.error("   SETUP FAILED");
  console.error("========================================");
  console.error("");
  console.error(error.message);
  console.error("");
  process.exit(1);
}