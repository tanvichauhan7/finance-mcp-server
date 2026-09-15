import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDb } from "./db.js";

const server = new Server(
  { name: "finance-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ============================================================
// CONSTANTS / BUSINESS RULES
// ============================================================

const REVENUE_LINES = [
  "Product Revenue",
  "Admin Fee Revenue",
  "Rebate Revenue",
  "Other Revenue",
];

const COGS_LINES = [
  "Product COGS",
  "Rebate COGS",
];

const PERIOD_REGEX = /^\d{4}-\d{2}$/;

// ============================================================
// GENERIC TOOL SCHEMAS
// ============================================================

const listCollectionsSchema = z.object({});

const getSchemaSchema = z.object({
  collection: z.string(),
});

const queryFinanceDataSchema = z.object({
  collection: z.string(),
  filter: z.record(z.any()).optional(),
  projection: z.record(z.any()).optional(),
  sort: z.record(z.number()).optional(),
  limit: z.number().int().positive().max(500).default(50),
});

const aggregateFinanceDataSchema = z.object({
  collection: z.string(),
  pipeline: z.array(z.record(z.any())),
});

const getSummaryStatsSchema = z.object({
  collection: z.string(),
  numericField: z.string(),
  groupByField: z.string().optional(),
  filter: z.record(z.any()).optional(),
});

// ============================================================
// FINANCE TOOL SCHEMAS
// ============================================================

const periodSchema = z.object({
  fiscalPeriod: z
    .string()
    .regex(PERIOD_REGEX)
    .describe("Fiscal period in YYYY-MM format, e.g. 2026-08"),
});

const clientPeriodSchema = z.object({
  fiscalPeriod: z.string().regex(PERIOD_REGEX),
  oracleId: z.string().optional(),
  clientName: z.string().optional(),
});

const channelRevenueSchema = z.object({
  fiscalPeriod: z.string().regex(PERIOD_REGEX),
  channels: z
    .array(z.string())
    .optional()
    .describe("Optional channels such as Retail, Home Delivery, Specialty"),
});

const comparePeriodSchema = z.object({
  currentPeriod: z.string().regex(PERIOD_REGEX),
  previousPeriod: z.string().regex(PERIOD_REGEX),
});

const rebateCompareSchema = z.object({
  fiscalPeriod: z.string().regex(PERIOD_REGEX),
});

const exportProfitabilitySchema = z.object({
  fiscalPeriod: z.string().regex(PERIOD_REGEX),
  filename: z
    .string()
    .optional()
    .describe("Optional CSV filename"),
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function textResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`,
      },
    ],
    isError: true,
  };
}

function round(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 0;
  }

  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function getMonthVariance(current, previous) {
  const variance = current - previous;

  return {
    current,
    previous,
    variance: round(variance),
    variance_percent:
      previous === 0 ? null : round((variance / previous) * 100),
  };
}

async function getClientMap(db) {
  const clients = await db
    .collection("client_master")
    .find({})
    .project({
      _id: 0,
      Oracle_ID: 1,
      Client_Name: 1,
      Client_Segment: 1,
      Parent_Coalition: 1,
      Plan_Type: 1,
      Funding_Type: 1,
      Client_Status: 1,
      LOB: 1,
    })
    .toArray();

  return new Map(clients.map((c) => [c.Oracle_ID, c]));
}

async function getFinancialRows(db, fiscalPeriod) {
  return db
    .collection("financial_actuals")
    .find({
      Fiscal_Period: fiscalPeriod,
      Scenario: "Actual",
    })
    .toArray();
}

async function getVolumeRows(db, fiscalPeriod) {
  return db
    .collection("volume_metrics")
    .find({
      Fiscal_Period: fiscalPeriod,
    })
    .toArray();
}

function calculateFinancialTotals(rows) {
  let revenue = 0;
  let cogs = 0;
  let sga = 0;

  for (const row of rows) {
    const amount = Number(row.Amount_USD) || 0;

    if (REVENUE_LINES.includes(row.PnL_Line)) {
      revenue += amount;
    }

    if (COGS_LINES.includes(row.PnL_Line)) {
      cogs += amount;
    }

    if (row.PnL_Line === "SG&A") {
      sga += amount;
    }
  }

  const grossMargin = revenue - cogs;
  const ioi = grossMargin - sga;

  return {
    total_revenue_usd: round(revenue),
    total_cogs_usd: round(cogs),
    gross_margin_usd: round(grossMargin),
    gross_margin_pct:
      revenue === 0 ? 0 : round((grossMargin / revenue) * 100),
    sga_usd: round(sga),
    ioi_usd: round(ioi),
  };
}

function calculateClientProfitability(financialRows, volumeRows, clientMap) {
  const groups = new Map();

  for (const row of financialRows) {
    const oracleId = row.Oracle_ID;

    if (!oracleId) continue;

    if (!groups.has(oracleId)) {
      groups.set(oracleId, {
        Oracle_ID: oracleId,
        ...clientMap.get(oracleId),
        total_revenue_usd: 0,
        total_cogs_usd: 0,
        sga_usd: 0,
      });
    }

    const group = groups.get(oracleId);
    const amount = Number(row.Amount_USD) || 0;

    if (REVENUE_LINES.includes(row.PnL_Line)) {
      group.total_revenue_usd += amount;
    }

    if (COGS_LINES.includes(row.PnL_Line)) {
      group.total_cogs_usd += amount;
    }

    if (row.PnL_Line === "SG&A") {
      group.sga_usd += amount;
    }
  }

  for (const row of volumeRows) {
    if (row.Metric_Name !== "Adjusted Scripts") continue;

    const oracleId = row.Oracle_ID;

    if (!groups.has(oracleId)) {
      groups.set(oracleId, {
        Oracle_ID: oracleId,
        ...clientMap.get(oracleId),
        total_revenue_usd: 0,
        total_cogs_usd: 0,
        sga_usd: 0,
      });
    }

    groups.get(oracleId).adjusted_scripts =
      (groups.get(oracleId).adjusted_scripts || 0) +
      (Number(row.Metric_Value) || 0);
  }

  return Array.from(groups.values()).map((group) => {
    const revenue = group.total_revenue_usd;
    const cogs = group.total_cogs_usd;
    const sga = group.sga_usd;
    const grossMargin = revenue - cogs;
    const ioi = grossMargin - sga;
    const scripts = group.adjusted_scripts || 0;

    return {
      Oracle_ID: group.Oracle_ID,
      Client_Name: group.Client_Name || null,
      Client_Segment: group.Client_Segment || null,
      Client_Status: group.Client_Status || null,
      total_revenue_usd: round(revenue),
      total_cogs_usd: round(cogs),
      gross_margin_usd: round(grossMargin),
      gross_margin_pct:
        revenue === 0 ? 0 : round((grossMargin / revenue) * 100),
      sga_usd: round(sga),
      ioi_usd: round(ioi),
      adjusted_scripts: round(scripts),
      margin_per_script_usd:
        scripts === 0 ? 0 : round(grossMargin / scripts),
    };
  });
}

// ============================================================
// TOOL LIST
// ============================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ----------------------------------------------------------
    // GENERIC TOOLS
    // ----------------------------------------------------------

    {
      name: "list_collections",
      description:
        "List all collections available in the finance database with document counts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },

    {
      name: "get_schema",
      description:
        "Return a sample document and field list for a finance collection.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
        },
        required: ["collection"],
      },
    },

    {
      name: "query_finance_data",
      description:
        "Query finance records from MongoDB using filter, projection, sort and limit.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          filter: { type: "object" },
          projection: { type: "object" },
          sort: { type: "object" },
          limit: { type: "number" },
        },
        required: ["collection"],
      },
    },

    {
      name: "aggregate_finance_data",
      description:
        "Run a MongoDB aggregation pipeline against a finance collection.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          pipeline: {
            type: "array",
            items: { type: "object" },
          },
        },
        required: ["collection", "pipeline"],
      },
    },

    {
      name: "get_summary_stats",
      description:
        "Calculate count, sum, average, minimum and maximum for a numeric field.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          numericField: { type: "string" },
          groupByField: { type: "string" },
          filter: { type: "object" },
        },
        required: ["collection", "numericField"],
      },
    },

    // ----------------------------------------------------------
    // POC FINANCE TOOLS
    // ----------------------------------------------------------

    {
      name: "list_clients",
      description:
        "P-001: List all available clients from Client Master.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },

    {
      name: "get_profitability",
      description:
        "P-002: Calculate total revenue, COGS, gross margin, gross margin percentage, SG&A and IOI for a fiscal period.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: {
            type: "string",
            description: "YYYY-MM, e.g. 2026-08",
          },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "get_profitability_by_client",
      description:
        "P-003/P-004: Calculate client-level revenue, COGS, gross margin, SG&A, IOI, adjusted scripts and margin per script.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: {
            type: "string",
            description: "YYYY-MM",
          },
          oracleId: {
            type: "string",
            description: "Optional Oracle client ID",
          },
          clientName: {
            type: "string",
            description: "Optional client name",
          },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "get_revenue_by_channel",
      description:
        "P-005: Break down total revenue by Retail, Home Delivery and Specialty for a fiscal period.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: {
            type: "string",
            description: "YYYY-MM",
          },
          channels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "compare_gross_margin",
      description:
        "P-006: Compare total gross margin between two periods and calculate absolute and percentage variance.",
      inputSchema: {
        type: "object",
        properties: {
          currentPeriod: { type: "string" },
          previousPeriod: { type: "string" },
        },
        required: ["currentPeriod", "previousPeriod"],
      },
    },

    {
      name: "get_client_margin_movement",
      description:
        "P-007: Compare client gross margin between two periods and identify the largest unfavorable movement.",
      inputSchema: {
        type: "object",
        properties: {
          currentPeriod: { type: "string" },
          previousPeriod: { type: "string" },
        },
        required: ["currentPeriod", "previousPeriod"],
      },
    },

    {
      name: "get_unit_economics",
      description:
        "P-008: Show adjusted scripts and margin per script by client for a fiscal period.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: { type: "string" },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "compare_rebate_sources",
      description:
        "P-009: Compare GL rebate margin with RxMax rebate margin for a fiscal period. Retain both sources and identify the selected source.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: { type: "string" },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "get_unmapped_rebates",
      description:
        "P-010: Return rebate records with missing Oracle ID or Mapping_Status = Unmapped.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: { type: "string" },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "get_reconciliation_reviews",
      description:
        "P-011: Identify client-periods requiring reconciliation review because at least one financial row is Out of Tolerance.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: { type: "string" },
        },
        required: ["fiscalPeriod"],
      },
    },

    {
      name: "export_client_profitability",
      description:
        "P-012: Create a flat CSV file containing client profitability for a fiscal period, suitable for Excel.",
      inputSchema: {
        type: "object",
        properties: {
          fiscalPeriod: { type: "string" },
          filename: { type: "string" },
        },
        required: ["fiscalPeriod"],
      },
    },
  ],
}));

// ============================================================
// TOOL IMPLEMENTATIONS
// ============================================================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const db = await getDb();

    // ========================================================
    // GENERIC: LIST COLLECTIONS
    // ========================================================

    if (name === "list_collections") {
      listCollectionsSchema.parse(args ?? {});

      const collections = await db.listCollections().toArray();

      const withCounts = await Promise.all(
        collections.map(async (c) => ({
          name: c.name,
          count: await db.collection(c.name).countDocuments(),
        }))
      );

      return textResult(withCounts);
    }

    // ========================================================
    // GENERIC: GET SCHEMA
    // ========================================================

    if (name === "get_schema") {
      const { collection } = getSchemaSchema.parse(args);

      const sample = await db.collection(collection).findOne({});

      if (!sample) {
        return textResult({
          collection,
          fields: [],
          sample: null,
        });
      }

      return textResult({
        collection,
        fields: Object.keys(sample),
        sample,
      });
    }

    // ========================================================
    // GENERIC: QUERY
    // ========================================================

    if (name === "query_finance_data") {
      const {
        collection,
        filter,
        projection,
        sort,
        limit,
      } = queryFinanceDataSchema.parse(args);

      const cursor = db
        .collection(collection)
        .find(filter ?? {}, { projection })
        .limit(limit);

      if (sort) {
        cursor.sort(sort);
      }

      const docs = await cursor.toArray();

      return textResult(docs);
    }

    // ========================================================
    // GENERIC: AGGREGATION
    // ========================================================

    if (name === "aggregate_finance_data") {
      const { collection, pipeline } =
        aggregateFinanceDataSchema.parse(args);

      const docs = await db
        .collection(collection)
        .aggregate(pipeline)
        .toArray();

      return textResult(docs);
    }

    // ========================================================
    // GENERIC: SUMMARY STATS
    // ========================================================

    if (name === "get_summary_stats") {
      const {
        collection,
        numericField,
        groupByField,
        filter,
      } = getSummaryStatsSchema.parse(args);

      const pipeline = [];

      if (filter) {
        pipeline.push({ $match: filter });
      }

      pipeline.push({
        $group: {
          _id: groupByField ? `$${groupByField}` : null,
          count: { $sum: 1 },
          total: { $sum: `$${numericField}` },
          average: { $avg: `$${numericField}` },
          min: { $min: `$${numericField}` },
          max: { $max: `$${numericField}` },
        },
      });

      const docs = await db
        .collection(collection)
        .aggregate(pipeline)
        .toArray();

      return textResult(docs);
    }

    // ========================================================
    // P-001 LIST CLIENTS
    // ========================================================

    if (name === "list_clients") {
      const clients = await db
        .collection("client_master")
        .find({})
        .project({
          _id: 0,
        })
        .sort({ Oracle_ID: 1 })
        .toArray();

      return textResult(clients);
    }

    // ========================================================
    // P-002 PROFITABILITY
    // ========================================================

    if (name === "get_profitability") {
      const { fiscalPeriod } = periodSchema.parse(args);

      const rows = await getFinancialRows(db, fiscalPeriod);

      const result = calculateFinancialTotals(rows);

      return textResult({
        fiscal_period: fiscalPeriod,
        currency: "USD",
        ...result,
      });
    }

    // ========================================================
    // P-003 / P-004 CLIENT PROFITABILITY
    // ========================================================

    if (name === "get_profitability_by_client") {
      const {
        fiscalPeriod,
        oracleId,
        clientName,
      } = clientPeriodSchema.parse(args);

      const clientMap = await getClientMap(db);

      let financialRows = await getFinancialRows(db, fiscalPeriod);

      let volumeRows = await getVolumeRows(db, fiscalPeriod);

      if (oracleId) {
        financialRows = financialRows.filter(
          (r) => r.Oracle_ID === oracleId
        );

        volumeRows = volumeRows.filter(
          (r) => r.Oracle_ID === oracleId
        );
      }

      const results = calculateClientProfitability(
        financialRows,
        volumeRows,
        clientMap
      );

      let filteredResults = results;

      if (clientName) {
        filteredResults = results.filter(
          (r) =>
            r.Client_Name?.toLowerCase() ===
            clientName.toLowerCase()
        );
      }

      filteredResults.sort(
        (a, b) => b.gross_margin_usd - a.gross_margin_usd
      );

      return textResult({
        fiscal_period: fiscalPeriod,
        currency: "USD",
        count: filteredResults.length,
        results: filteredResults,
      });
    }

    // ========================================================
    // P-005 REVENUE BY CHANNEL
    // ========================================================

    if (name === "get_revenue_by_channel") {
      const { fiscalPeriod, channels } =
        channelRevenueSchema.parse(args);

      const rows = await getFinancialRows(db, fiscalPeriod);

      const requestedChannels =
        channels || ["Retail", "Home Delivery", "Specialty"];

      const grouped = {};

      for (const channel of requestedChannels) {
        grouped[channel] = 0;
      }

      for (const row of rows) {
        if (!REVENUE_LINES.includes(row.PnL_Line)) continue;

        if (!requestedChannels.includes(row.Product_Channel)) {
          continue;
        }

        grouped[row.Product_Channel] +=
          Number(row.Amount_USD) || 0;
      }

      const results = Object.entries(grouped)
        .map(([channel, revenue]) => ({
          Product_Channel: channel,
          total_revenue_usd: round(revenue),
        }))
        .sort(
          (a, b) =>
            b.total_revenue_usd - a.total_revenue_usd
        );

      return textResult({
        fiscal_period: fiscalPeriod,
        currency: "USD",
        results,
      });
    }

    // ========================================================
    // P-006 GROSS MARGIN VARIANCE
    // ========================================================

    if (name === "compare_gross_margin") {
      const {
        currentPeriod,
        previousPeriod,
      } = comparePeriodSchema.parse(args);

      const currentRows = await getFinancialRows(
        db,
        currentPeriod
      );

      const previousRows = await getFinancialRows(
        db,
        previousPeriod
      );

      const current =
        calculateFinancialTotals(currentRows).gross_margin_usd;

      const previous =
        calculateFinancialTotals(previousRows).gross_margin_usd;

      return textResult({
        metric: "Gross Margin",
        currency: "USD",
        current_period: currentPeriod,
        previous_period: previousPeriod,
        ...getMonthVariance(current, previous),
      });
    }

    // ========================================================
    // P-007 CLIENT MARGIN MOVEMENT
    // ========================================================

    if (name === "get_client_margin_movement") {
      const {
        currentPeriod,
        previousPeriod,
      } = comparePeriodSchema.parse(args);

      const clientMap = await getClientMap(db);

      const currentFinancial = await getFinancialRows(
        db,
        currentPeriod
      );

      const previousFinancial = await getFinancialRows(
        db,
        previousPeriod
      );

      const currentVolume = await getVolumeRows(
        db,
        currentPeriod
      );

      const previousVolume = await getVolumeRows(
        db,
        previousPeriod
      );

      const currentResults = calculateClientProfitability(
        currentFinancial,
        currentVolume,
        clientMap
      );

      const previousResults = calculateClientProfitability(
        previousFinancial,
        previousVolume,
        clientMap
      );

      const previousMap = new Map(
        previousResults.map((r) => [
          r.Oracle_ID,
          r,
        ])
      );

      const movements = currentResults.map((current) => {
        const previous = previousMap.get(
          current.Oracle_ID
        );

        const previousGM =
          previous?.gross_margin_usd || 0;

        const variance =
          current.gross_margin_usd - previousGM;

        return {
          Oracle_ID: current.Oracle_ID,
          Client_Name: current.Client_Name,
          previous_gross_margin_usd: round(previousGM),
          current_gross_margin_usd: round(
            current.gross_margin_usd
          ),
          variance_usd: round(variance),
          variance_percent:
            previousGM === 0
              ? null
              : round((variance / previousGM) * 100),
          favorable:
            variance >= 0,
        };
      });

      movements.sort(
        (a, b) => a.variance_usd - b.variance_usd
      );

      const unfavorable = movements.filter(
        (m) => m.variance_usd < 0
      );

      return textResult({
        current_period: currentPeriod,
        previous_period: previousPeriod,
        largest_unfavorable_movement:
          unfavorable.length > 0
            ? unfavorable[0]
            : null,
        all_client_movements: movements,
      });
    }

    // ========================================================
    // P-008 UNIT ECONOMICS
    // ========================================================

    if (name === "get_unit_economics") {
      const { fiscalPeriod } =
        periodSchema.parse(args);

      const clientMap = await getClientMap(db);

      const financialRows = await getFinancialRows(
        db,
        fiscalPeriod
      );

      const volumeRows = await getVolumeRows(
        db,
        fiscalPeriod
      );

      const profitability =
        calculateClientProfitability(
          financialRows,
          volumeRows,
          clientMap
        );

      const results = profitability
        .map((r) => ({
          Oracle_ID: r.Oracle_ID,
          Client_Name: r.Client_Name,
          Adjusted_Scripts: r.adjusted_scripts,
          Gross_Margin_USD: r.gross_margin_usd,
          Margin_Per_Script_USD:
            r.margin_per_script_usd,
        }))
        .sort(
          (a, b) =>
            b.Margin_Per_Script_USD -
            a.Margin_Per_Script_USD
        );

      return textResult({
        fiscal_period: fiscalPeriod,
        results,
      });
    }

    // ========================================================
    // P-009 REBATE SOURCE COMPARISON
    // ========================================================

    if (name === "compare_rebate_sources") {
      const { fiscalPeriod } =
        rebateCompareSchema.parse(args);

      const rows = await db
        .collection("rebate_economics")
        .find({
          Fiscal_Period: fiscalPeriod,
        })
        .toArray();

      const sources = {};

      for (const row of rows) {
        const source = row.Rebate_Source;

        if (!sources[source]) {
          sources[source] = {
            Rebate_Source: source,
            rebate_revenue_usd: 0,
            rebate_cogs_usd: 0,
            rebate_margin_usd: 0,
            selected_count: 0,
            record_count: 0,
          };
        }

        sources[source].rebate_revenue_usd +=
          Number(row.Rebate_Revenue_USD) || 0;

        sources[source].rebate_cogs_usd +=
          Number(row.Rebate_COGS_USD) || 0;

        sources[source].rebate_margin_usd +=
          Number(row.Rebate_Margin_USD) || 0;

        sources[source].record_count++;

        if (row.Source_Selected === "Y") {
          sources[source].selected_count++;
        }
      }

      const results = Object.values(sources).map(
        (source) => ({
          ...source,
          rebate_revenue_usd: round(
            source.rebate_revenue_usd
          ),
          rebate_cogs_usd: round(
            source.rebate_cogs_usd
          ),
          rebate_margin_usd: round(
            source.rebate_margin_usd
          ),
        })
      );

      return textResult({
        fiscal_period: fiscalPeriod,
        rule:
          "BR-009: Use Source_Selected = Y as the selected source while retaining both GL and RxMax records.",
        results,
      });
    }

    // ========================================================
    // P-010 UNMAPPED REBATES
    // ========================================================

    if (name === "get_unmapped_rebates") {
      const { fiscalPeriod } =
        periodSchema.parse(args);

      const rows = await db
        .collection("rebate_economics")
        .find({
          Fiscal_Period: fiscalPeriod,
          $or: [
            {
              Oracle_ID: {
                $in: [null, "", undefined],
              },
            },
            {
              Mapping_Status: "Unmapped",
            },
          ],
        })
        .project({
          _id: 0,
        })
        .toArray();

      return textResult({
        fiscal_period: fiscalPeriod,
        count: rows.length,
        exceptions: rows,
      });
    }

    // ========================================================
    // P-011 RECONCILIATION REVIEW
    // ========================================================

    if (name === "get_reconciliation_reviews") {
      const { fiscalPeriod } =
        periodSchema.parse(args);

      const rows = await db
        .collection("financial_actuals")
        .find({
          Fiscal_Period: fiscalPeriod,
          Reconciliation_Status: "Out of Tolerance",
        })
        .project({
          _id: 0,
        })
        .toArray();

      const grouped = new Map();

      for (const row of rows) {
        const key = row.Oracle_ID;

        if (!grouped.has(key)) {
          grouped.set(key, {
            Oracle_ID: key,
            Fiscal_Period: fiscalPeriod,
            status: "Review",
            out_of_tolerance_rows: 0,
            affected_channels: new Set(),
            pnl_lines: new Set(),
          });
        }

        const item = grouped.get(key);

        item.out_of_tolerance_rows++;

        if (row.Product_Channel) {
          item.affected_channels.add(
            row.Product_Channel
          );
        }

        if (row.PnL_Line) {
          item.pnl_lines.add(row.PnL_Line);
        }
      }

      const clientMap = await getClientMap(db);

      const results = Array.from(grouped.values()).map(
        (item) => ({
          Oracle_ID: item.Oracle_ID,
          Client_Name:
            clientMap.get(item.Oracle_ID)?.Client_Name ||
            null,
          Fiscal_Period: item.Fiscal_Period,
          status: item.status,
          out_of_tolerance_rows:
            item.out_of_tolerance_rows,
          affected_channels: Array.from(
            item.affected_channels
          ),
          pnl_lines: Array.from(item.pnl_lines),
        })
      );

      return textResult({
        fiscal_period: fiscalPeriod,
        count: results.length,
        results,
      });
    }

    // ========================================================
    // P-012 CSV EXPORT
    // ========================================================

    if (name === "export_client_profitability") {
      const {
        fiscalPeriod,
        filename,
      } = exportProfitabilitySchema.parse(args);

      const clientMap = await getClientMap(db);

      const financialRows = await getFinancialRows(
        db,
        fiscalPeriod
      );

      const volumeRows = await getVolumeRows(
        db,
        fiscalPeriod
      );

      const profitability =
        calculateClientProfitability(
          financialRows,
          volumeRows,
          clientMap
        );

      profitability.sort(
        (a, b) => b.gross_margin_usd - a.gross_margin_usd
      );

      const reviewRows = await db
        .collection("financial_actuals")
        .find({
          Fiscal_Period: fiscalPeriod,
          Reconciliation_Status: "Out of Tolerance",
        })
        .project({
          Oracle_ID: 1,
        })
        .toArray();

      const reviewClients = new Set(
        reviewRows.map((r) => r.Oracle_ID)
      );

      const csvRows = profitability.map((r) => ({
        Oracle_ID: r.Oracle_ID,
        Client_Name: r.Client_Name,
        Fiscal_Period: fiscalPeriod,
        Total_Revenue_USD: r.total_revenue_usd,
        Total_COGS_USD: r.total_cogs_usd,
        Gross_Margin_USD: r.gross_margin_usd,
        Gross_Margin_Pct: r.gross_margin_pct,
        SGA_USD: r.sga_usd,
        IOI_USD: r.ioi_usd,
        Adjusted_Scripts: r.adjusted_scripts,
        Margin_Per_Script_USD:
          r.margin_per_script_usd,
        Reconciliation_Status:
          reviewClients.has(r.Oracle_ID)
            ? "Review"
            : "OK",
      }));

      const headers = Object.keys(
        csvRows[0] || {
          Oracle_ID: "",
          Client_Name: "",
          Fiscal_Period: "",
          Total_Revenue_USD: "",
          Total_COGS_USD: "",
          Gross_Margin_USD: "",
          Gross_Margin_Pct: "",
          SGA_USD: "",
          IOI_USD: "",
          Adjusted_Scripts: "",
          Margin_Per_Script_USD: "",
          Reconciliation_Status: "",
        }
      );

      const escapeCsv = (value) => {
        if (value === null || value === undefined) {
          return "";
        }

        const stringValue = String(value);

        if (
          stringValue.includes(",") ||
          stringValue.includes('"') ||
          stringValue.includes("\n")
        ) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }

        return stringValue;
      };

      const csv = [
        headers.join(","),
        ...csvRows.map((row) =>
          headers
            .map((header) => escapeCsv(row[header]))
            .join(",")
        ),
      ].join("\n");

      const outputDir = path.join(
        process.cwd(),
        "outputs"
      );

      fs.mkdirSync(outputDir, {
        recursive: true,
      });

      const safeFilename =
        filename || `client_profitability_${fiscalPeriod}.csv`;

      const outputPath = path.join(
        outputDir,
        safeFilename
      );

      fs.writeFileSync(
        outputPath,
        csv,
        "utf8"
      );

      return textResult({
        success: true,
        fiscal_period: fiscalPeriod,
        records_exported: csvRows.length,
        file: outputPath,
        filename: safeFilename,
      });
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (err) {
    return errorResult(err.message);
  }
});

// ============================================================
// START MCP SERVER
// ============================================================

const transport = new StdioServerTransport();

await server.connect(transport);