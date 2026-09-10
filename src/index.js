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

// ---- Tool schemas -----------------------------------------------------

const listCollectionsSchema = z.object({});

const getSchemaSchema = z.object({
  collection: z.string().describe("Name of the collection to inspect"),
});

const queryFinanceDataSchema = z.object({
  collection: z.string().describe("Name of the collection to query"),
  filter: z
    .record(z.any())
    .optional()
    .describe("MongoDB filter object, e.g. { \"quarter\": \"Q1-2026\" }"),
  projection: z
    .record(z.any())
    .optional()
    .describe("Fields to include/exclude, e.g. { \"_id\": 0 }"),
  sort: z
    .record(z.number())
    .optional()
    .describe("Sort spec, e.g. { \"date\": -1 }"),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .default(50)
    .describe("Max documents to return (default 50, max 500)"),
});

const aggregateFinanceDataSchema = z.object({
  collection: z.string().describe("Name of the collection to aggregate"),
  pipeline: z
    .array(z.record(z.any()))
    .describe("MongoDB aggregation pipeline stages"),
});

const getSummaryStatsSchema = z.object({
  collection: z.string().describe("Name of the collection"),
  numericField: z.string().describe("Numeric field to summarize, e.g. 'revenue'"),
  groupByField: z
    .string()
    .optional()
    .describe("Optional field to group by, e.g. 'quarter' or 'department'"),
  filter: z.record(z.any()).optional().describe("Optional filter before summarizing"),
});

// ---- Tool list ----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_collections",
      description:
        "List all collections available in the finance database, with document counts.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_schema",
      description:
        "Return a sample document and inferred field list for a given collection, so the caller knows what fields exist before querying.",
      inputSchema: {
        type: "object",
        properties: { collection: { type: "string" } },
        required: ["collection"],
      },
    },
    {
      name: "query_finance_data",
      description:
        "Fetch finance model records from a collection with an optional MongoDB filter, projection, sort, and limit. Use this for direct lookups (e.g. 'show me Q1 2026 revenue rows').",
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
        "Run a MongoDB aggregation pipeline against a collection. Use for grouping, joins across collections, or computed fields that a simple query can't express.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          pipeline: { type: "array", items: { type: "object" } },
        },
        required: ["collection", "pipeline"],
      },
    },
    {
      name: "get_summary_stats",
      description:
        "Quickly compute count/sum/avg/min/max for a numeric field, optionally grouped by another field (e.g. total revenue by quarter).",
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
  ],
}));

// ---- Tool implementations ------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const db = await getDb();

  try {
    switch (name) {
      case "list_collections": {
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

      case "get_schema": {
        const { collection } = getSchemaSchema.parse(args);
        const sample = await db.collection(collection).findOne({});
        if (!sample) return textResult({ collection, fields: [], sample: null });
        return textResult({
          collection,
          fields: Object.keys(sample),
          sample,
        });
      }

      case "query_finance_data": {
        const { collection, filter, projection, sort, limit } =
          queryFinanceDataSchema.parse(args);
        const cursor = db
          .collection(collection)
          .find(filter ?? {}, { projection })
          .limit(limit);
        if (sort) cursor.sort(sort);
        const docs = await cursor.toArray();
        return textResult(docs);
      }

      case "aggregate_finance_data": {
        const { collection, pipeline } = aggregateFinanceDataSchema.parse(args);
        const docs = await db.collection(collection).aggregate(pipeline).toArray();
        return textResult(docs);
      }

      case "get_summary_stats": {
        const { collection, numericField, groupByField, filter } =
          getSummaryStatsSchema.parse(args);
        const pipeline = [];
        if (filter) pipeline.push({ $match: filter });
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
        const docs = await db.collection(collection).aggregate(pipeline).toArray();
        return textResult(docs);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
