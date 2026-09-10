# Finance MCP Server

Exposes your finance model data (stored in MongoDB) to GitHub Copilot Chat
in VS Code via the Model Context Protocol (MCP). Runs locally.

## 1. Prerequisites

- Node.js 18+
- MongoDB running locally (`mongod` on `127.0.0.1:27017` by default)
  - Install: https://www.mongodb.com/try/download/community
  - Or run via Docker: `docker run -d -p 27017:27017 --name finance-mongo mongo`

## 2. Install

```bash
cd finance-mcp-server
npm install
```

## 3. Load your data

Two options:

**A. Use the example seed script as a template**
Edit `src/seed.js` — replace `sampleRevenue` / `sampleAssumptions` with your
actual finance model rows (or write a script that reads your CSV/Excel export
and inserts it). Then:

```bash
npm run seed
```

**B. Import an existing export directly**
If you already have your finance model as CSV/JSON:

```bash
mongoimport --db finance_model --collection revenue --type csv --headerline --file your_export.csv
```

## 4. Configure environment (optional)

Copy `.env.example` to `.env` and adjust `MONGODB_URI` / `MONGODB_DB` if your
MongoDB isn't running on the default local port, or if you rename the database.

## 5. Connect to GitHub Copilot in VS Code

The included `.vscode/mcp.json` already points Copilot at this server. Steps:

1. Open this project's parent folder (the one containing `finance-mcp-server/`) in VS Code.
2. Make sure `.vscode/mcp.json` is at the workspace root (adjust the `args` path
   if you place the server folder elsewhere).
3. Open Copilot Chat → it should detect the MCP server automatically
   (VS Code 1.99+, Copilot Chat with MCP support enabled).
4. If it doesn't auto-start, open the Command Palette → "MCP: List Servers" →
   start `finance-mcp-server`.
5. Ask Copilot things like:
   - "What collections are in the finance database?"
   - "Show me Q1 2026 revenue by department"
   - "What's the total revenue and average COGS for Q2 2026?"

Copilot will call the server's tools (`list_collections`, `get_schema`,
`query_finance_data`, `aggregate_finance_data`, `get_summary_stats`) instead
of guessing from text.

## 6. Available tools

| Tool | Purpose |
|---|---|
| `list_collections` | See what data exists and how many records |
| `get_schema` | Inspect fields via a sample document before querying |
| `query_finance_data` | Filter/sort/limit a collection directly |
| `aggregate_finance_data` | Run a full MongoDB aggregation pipeline |
| `get_summary_stats` | Quick sum/avg/min/max, optionally grouped |

## 7. Extending

- Add more collections by just inserting into MongoDB — no server changes needed;
  `list_collections` and `get_schema` will pick them up automatically.
- If you need write access (e.g. Copilot updating assumptions), add a new tool
  following the same pattern in `src/index.js`, but consider adding validation
  since writes are higher-risk than reads.
