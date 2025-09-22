// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MetaAdsTools } from "./tools.js";
import { MetaConfig } from "./types.js";

/**
 * Wrap a JSON value into a valid MCP tool response.
 * We intentionally type this as `any` to satisfy the SDK's union for content blocks
 * and avoid literal-type widening issues in TS (which caused your previous errors).
 */
const wrap = (json: unknown): any => ({
  content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
});

export function startServer(cfg: MetaConfig) {
  const server = new McpServer({ name: "meta-ads-mcp", version: "1.0.0" });
  const tools = new MetaAdsTools(cfg);

  // ---------- Zod RAW SHAPES (SDK expects ZodRawShape, not z.object(...)) ----------
  const DateRangeShape: z.ZodRawShape = {
    since: z.string().describe("YYYY-MM-DD"),
    until: z.string().describe("YYYY-MM-DD"),
  };

  const AccountSummaryShape: z.ZodRawShape = {
    ad_account_id: z.string().optional(),
    date_range: z.object(DateRangeShape),
    currency: z.string().optional(),
    attribution_setting: z.string().optional(),
  };

  const CampaignPerfShape: z.ZodRawShape = {
    campaign_ids: z.array(z.string()).optional(),
    date_range: z.object(DateRangeShape),
    performance_thresholds: z
      .object({ cpa: z.number().optional(), roas: z.number().optional() })
      .optional(),
  };

  const AudienceBreakdownShape: z.ZodRawShape = {
    level: z.enum(["adset", "campaign"]).optional(),
    ids: z.array(z.string()).optional(),
    date_range: z.object(DateRangeShape),
    breakdowns: z.array(z.string()).optional(),
  };

  const CreativeEffectivenessShape: z.ZodRawShape = {
    ad_ids: z.array(z.string()).optional(),
    date_range: z.object(DateRangeShape),
    include_preview: z.boolean().optional(),
  };

  const SpendAllocationShape: z.ZodRawShape = {
    date_range: z.object(DateRangeShape),
    level: z.enum(["campaign", "adset", "ad"]).optional(),
  };

  const ConversionFunnelShape: z.ZodRawShape = {
    date_range: z.object(DateRangeShape),
    attribution_window_days: z.number().optional(),
  };

  const DeliveryInsightsShape: z.ZodRawShape = {
    date_range: z.object(DateRangeShape),
    placements: z.array(z.string()).optional(),
  };

  const AdvancedAttributionShape: z.ZodRawShape = {
    date_range: z.object(DateRangeShape),
    assumed_ltv: z.number().optional(),
    cac_target: z.number().optional(),
  };

  // ---------- Register tools ----------
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List ad accounts the current token can access",
      // no input schema
    },
    async () => wrap(await tools.list_accounts())
  );

  server.registerTool(
    "get_account_performance_summary",
    {
      title: "Account Performance Summary",
      description: "High-level account KPIs and trends",
      inputSchema: AccountSummaryShape,
    },
    async (args) => {
      // optional runtime validation
      const parsed = z.object(AccountSummaryShape).parse(args ?? {});
      return wrap(await tools.get_account_performance_summary(parsed as any));
    }
  );

  server.registerTool(
    "analyze_campaign_performance",
    {
      title: "Analyze Campaigns",
      description: "Rank campaigns by ROAS/CPA; flag underperformers; suggest budget shifts",
      inputSchema: CampaignPerfShape,
    },
    async (args) => {
      const parsed = z.object(CampaignPerfShape).parse(args ?? {});
      return wrap(await tools.analyze_campaign_performance(parsed as any));
    }
  );

  server.registerTool(
    "get_audience_performance_breakdown",
    {
      title: "Audience Breakdown",
      description: "Breakdowns across demographics, interests/behaviors, and placements",
      inputSchema: AudienceBreakdownShape,
    },
    async (args) => {
      const parsed = z.object(AudienceBreakdownShape).parse(args ?? {});
      return wrap(await tools.get_audience_performance_breakdown(parsed as any));
    }
  );

  server.registerTool(
    "analyze_creative_effectiveness",
    {
      title: "Creative Effectiveness",
      description: "Evaluate ad creatives by format and KPIs; surface winners/losers",
      inputSchema: CreativeEffectivenessShape,
    },
    async (args) => {
      const parsed = z.object(CreativeEffectivenessShape).parse(args ?? {});
      return wrap(await tools.analyze_creative_effectiveness(parsed as any));
    }
  );

  server.registerTool(
    "get_spend_allocation_insights",
    {
      title: "Spend Allocation",
      description: "Distribution by campaign/adset/ad with reallocation suggestions",
      inputSchema: SpendAllocationShape,
    },
    async (args) => {
      const parsed = z.object(SpendAllocationShape).parse(args ?? {});
      return wrap(await tools.get_spend_allocation_insights(parsed as any));
    }
  );

  server.registerTool(
    "analyze_conversion_funnel",
    {
      title: "Conversion Funnel",
      description: "Funnel from view_content to purchase, drop-offs and recommendations",
      inputSchema: ConversionFunnelShape,
    },
    async (args) => {
      const parsed = z.object(ConversionFunnelShape).parse(args ?? {});
      return wrap(await tools.analyze_conversion_funnel(parsed as any));
    }
  );

  server.registerTool(
    "get_ad_delivery_insights",
    {
      title: "Delivery Insights",
      description: "Placement & position performance; competitiveness proxy",
      inputSchema: DeliveryInsightsShape,
    },
    async (args) => {
      const parsed = z.object(DeliveryInsightsShape).parse(args ?? {});
      return wrap(await tools.get_ad_delivery_insights(parsed as any));
    }
  );

  server.registerTool(
    "calculate_advanced_attribution",
    {
      title: "Advanced Attribution",
      description: "CAC, ROAS, LTV heuristic, CLV/CAC; guidance for multi-touch",
      inputSchema: AdvancedAttributionShape,
    },
    async (args) => {
      const parsed = z.object(AdvancedAttributionShape).parse(args ?? {});
      return wrap(await tools.calculate_advanced_attribution(parsed as any));
    }
  );

  // ---------- Connect over stdio ----------
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
