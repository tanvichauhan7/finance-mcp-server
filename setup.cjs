const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

console.log(`
========================================
   Finance MCP Setup
========================================
`);

const excelFile = path.join(__dirname, "Test_POC.xlsx");

if (!fs.existsSync(excelFile)) {
  console.error(`
========================================
   SETUP FAILED
========================================

Test_POC.xlsx was not found in the project folder.
`);
  process.exit(1);
}

console.log("Test_POC.xlsx found.");
console.log("Importing Excel data into MongoDB...\n");

try {
  execSync("node src/importExcel.cjs", {
    stdio: "inherit",
    cwd: __dirname
  });

  console.log(`
========================================
   SETUP COMPLETE
========================================

Database: finance_model

Your Finance MCP Server is ready.
========================================
`);

} catch (error) {
  console.error(`
========================================
   SETUP FAILED
========================================
`);

  process.exit(1);
}