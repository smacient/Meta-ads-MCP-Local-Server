import { MetaApi } from "./meta.js";
import { DateRange, MetaConfig, ToolResult } from "./types.js";
import { computeSpendKpis, round2, toNumber } from "./utils.js";

type AnyRow = Record<string, any>;
type KPIs = ReturnType<typeof computeSpendKpis>;

const getActions = (r: AnyRow): AnyRow[] =>
  Array.isArray(r.actions) ? (r.actions as AnyRow[]) : [];

const getActionValues = (r: AnyRow): AnyRow[] =>
  Array.isArray(r.action_values) ? (r.action_values as AnyRow[]) : [];

const purchaseCount = (r: AnyRow): number =>
  toNumber(getActions(r).find((a: AnyRow) => String(a.action_type ?? "").includes("purchase"))?.value);

const purchaseValue = (r: AnyRow): number =>
  toNumber(getActionValues(r).find((a: AnyRow) => String(a.action_type ?? "").includes("purchase"))?.value);

// Heuristic: if we see any video-related actions, treat creative as "video"
const looksVideo = (r: AnyRow): boolean => {
  const videoSignals = ["video_view", "thruplay", "video_play", "video_10s_views", "video_continuous_2_sec_watched_actions"];
  return getActions(r).some((a: AnyRow) => {
    const t = String(a.action_type ?? "").toLowerCase();
    return videoSignals.some((sig) => t.includes(sig));
  });
};

export class MetaAdsTools {
  private api: MetaApi;

  constructor(private cfg: MetaConfig) {
    this.api = new MetaApi(cfg);
  }

  // --- helper: normalize ad account id ---
  private accountIdOrThrow(adAccountId?: string): string {
    const raw = adAccountId || this.cfg.adAccountId;
    if (!raw || !raw.trim()) {
      throw new Error(
        "ad_account_id is required. Set META_AD_ACCOUNT_ID in .env or pass ad_account_id in the tool input."
      );
    }
    const id = raw.trim();
    return id.startsWith("act_") ? id : `act_${id}`;
  }

  // Admin: list ad accounts available for the token (no business field to avoid business_management)
  async list_accounts(): Promise<ToolResult> {
    const me: AnyRow = await this.api.get("/me", { fields: ["id", "name"] });

    const baseFields = ["id", "account_id", "name", "currency", "timezone_name"];
    let accounts: AnyRow[] = [];
    try {
      accounts = await this.api.getAllPages(`/me/adaccounts`, { fields: baseFields });
    } catch (err: any) {
      throw new Error(`Failed to list ad accounts: ${err?.message || String(err)}`);
    }

    return { raw_data: { me, accounts } };
  }

  // Account Overview
  async get_account_performance_summary(input: {
    ad_account_id?: string;
    date_range: DateRange;
    currency?: string;
    attribution_setting?: string;
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const fields = ["spend", "impressions", "clicks", "actions", "action_values", "objective", "reach"];

    const params: Record<string, any> = {
      fields,
      time_range: input.date_range,
      level: "account",
      breakdowns: [],
      time_increment: 1,
    };

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, params);
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const spend = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.spend), 0);
    const impressions = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.impressions), 0);
    const clicks = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.clicks), 0);

    let conversions = 0;
    let revenue = 0;
    for (const r of rows) {
      conversions += purchaseCount(r);
      revenue += purchaseValue(r);
    }

    const kpis = computeSpendKpis(spend, impressions, clicks, conversions || undefined, revenue || undefined);
    const analysis = {
      kpis,
      days: rows.length,
      objectives: Array.from(new Set(rows.map((x: AnyRow) => x.objective).filter(Boolean) as string[])),
    };

    const recommendations = {
      note: "Validate pixel/conversions mapping to ensure accurate CPA/ROAS. Consider narrowing fields to speed up responses.",
    };

    return { raw_data: rows, analysis, recommendations, meta: { accountId } };
  }

  // Campaign Analytics
  async analyze_campaign_performance(input: {
    ad_account_id?: string;
    campaign_ids?: string[];
    date_range: DateRange;
    performance_thresholds?: { cpa?: number; roas?: number };
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const fields = ["campaign_id", "campaign_name", "spend", "impressions", "clicks", "actions", "action_values"];
    const filtering: AnyRow[] | undefined = input.campaign_ids?.length
      ? [{ field: "campaign.id", operator: "IN", value: input.campaign_ids }]
      : undefined;

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level: "campaign",
      filtering,
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const enriched: (AnyRow & { kpis: KPIs })[] = rows.map((r: AnyRow) => {
      const spend = toNumber(r.spend);
      const imp = toNumber(r.impressions);
      const clk = toNumber(r.clicks);
      const conv = purchaseCount(r);
      const rev = purchaseValue(r);
      const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);
      return { ...r, kpis: k };
    });

    const rankedByRoas = [...enriched].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));
    const rankedByCpa = [...enriched].sort(
      (a, b) => (a.kpis.cpa ?? Number.POSITIVE_INFINITY) - (b.kpis.cpa ?? Number.POSITIVE_INFINITY)
    );

    const thresholds = input.performance_thresholds || {};
    const underperformers = enriched.filter((r) => {
      const roas = r.kpis.roas ?? 0;
      const cpa = r.kpis.cpa ?? Number.POSITIVE_INFINITY;
      const failRoas = thresholds.roas != null && roas < thresholds.roas;
      const failCpa = thresholds.cpa != null && cpa > thresholds.cpa;
      return failRoas || failCpa;
    });

    const recommendations = {
      reallocate_budget_from: underperformers.slice(0, 5).map((r) => ({
        id: r.campaign_id,
        name: r.campaign_name,
        kpis: r.kpis,
      })),
      to_top_campaigns: rankedByRoas.slice(0, 5).map((r) => ({
        id: r.campaign_id,
        name: r.campaign_name,
        kpis: r.kpis,
      })),
    };

    return { raw_data: rows, analysis: { rankedByRoas, rankedByCpa }, recommendations };
  }

  // Audience Insights
  async get_audience_performance_breakdown(input: {
    ad_account_id?: string;
    level?: "adset" | "campaign";
    ids?: string[];
    date_range: DateRange;
    breakdowns?: string[];
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const level = input.level || "adset";
    const fields = ["spend", "impressions", "clicks", "actions", "action_values", `${level}_id`, `${level}_name`];
    const filtering: AnyRow[] | undefined = input.ids?.length
      ? [{ field: `${level}.id`, operator: "IN", value: input.ids }]
      : undefined;
    const breakdowns = input.breakdowns?.length ? input.breakdowns : ["age", "gender", "publisher_platform"];

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level,
      breakdowns,
      filtering,
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const byKey = new Map<
      string,
      { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }
    >();
    for (const r of rows) {
      const key = breakdowns.map((b) => String((r as AnyRow)[b] ?? "")).join("|");
      const cur = byKey.get(key) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
      cur.spend += toNumber(r.spend);
      cur.impressions += toNumber(r.impressions);
      cur.clicks += toNumber(r.clicks);
      cur.conversions += purchaseCount(r);
      cur.revenue += purchaseValue(r);
      byKey.set(key, cur);
    }

    const result = Array.from(byKey.entries()).map(([k, v]) => ({
      key: k,
      kpis: computeSpendKpis(v.spend, v.impressions, v.clicks, v.conversions, v.revenue),
    }));
    const ranked = result.sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));

    return { raw_data: rows, analysis: { breakdowns, ranked } };
  }

  // Creative Performance
  async analyze_creative_effectiveness(input: {
    ad_account_id?: string;
    ad_ids?: string[];
    date_range: DateRange;
    include_preview?: boolean;
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);

    // IMPORTANT: do NOT request "creative" here; not a valid Insights field.
    const fields = ["ad_id", "ad_name", "spend", "impressions", "clicks", "actions", "action_values"];
    const filtering: AnyRow[] | undefined = input.ad_ids?.length
      ? [{ field: "ad.id", operator: "IN", value: input.ad_ids }]
      : undefined;

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level: "ad",
      filtering,
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    // Infer creative type from action types. This avoids extra permissions and invalid fields.
    const items = rows.map((r: AnyRow) => {
      const spend = toNumber(r.spend);
      const imp = toNumber(r.impressions);
      const clk = toNumber(r.clicks);
      const conv = purchaseCount(r);
      const rev = purchaseValue(r);
      const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);

      const creativeType = looksVideo(r) ? "video" : "image"; // heuristic; if you need exact type, fetch /{ad_id}?fields=creative{...}
      return { id: r.ad_id, name: r.ad_name, creativeType, kpis: k };
    });

    const byType: Record<string, { spend: number; imp: number; clk: number; conv: number; rev: number }> = {};
    for (const it of items) {
      const acc = byType[it.creativeType] || { spend: 0, imp: 0, clk: 0, conv: 0, rev: 0 };
      acc.spend += it.kpis.spend;
      acc.imp += it.kpis.impressions;
      acc.clk += it.kpis.clicks;
      acc.conv += it.kpis.conversions || 0;
      acc.rev += it.kpis.revenue || 0;
      byType[it.creativeType] = acc;
    }

    const typeSummary = Object.entries(byType).map(([t, v]) => ({
      type: t,
      kpis: computeSpendKpis(v.spend, v.imp, v.clk, v.conv, v.rev),
    }));

    const recommendations = {
      top_creatives: [...items].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0)).slice(0, 5),
      test_suggestions: ["Test new variants of the top performer format", "Rotate out creatives with low CTR and high CPA"],
    };

    return { raw_data: rows, analysis: { items, typeSummary }, recommendations };
  }

  // Budget Optimization
  async get_spend_allocation_insights(input: {
    ad_account_id?: string;
    date_range: DateRange;
    level?: "campaign" | "adset" | "ad";
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const level = input.level || "campaign";
    const fields = [`${level}_id`, `${level}_name`, "spend", "impressions", "clicks", "actions", "action_values"];

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level,
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const items = rows.map((r: AnyRow) => {
      const spend = toNumber(r.spend);
      const imp = toNumber(r.impressions);
      const clk = toNumber(r.clicks);
      const conv = purchaseCount(r);
      const rev = purchaseValue(r);
      const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);
      const id = String(r[`${level}_id`]);
      const name = String(r[`${level}_name`]);
      return { id, name, kpis: k };
    });

    const totalSpend = items.reduce((s: number, x: { kpis: KPIs }) => s + x.kpis.spend, 0);
    const allocation = items.map((x) => ({
      ...x,
      spend_share: round2((x.kpis.spend / Math.max(totalSpend, 1e-9)) * 100),
    }));

    const byRoasDesc = [...allocation].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));
    const byRoasAsc = [...allocation].sort(
      (a, b) => (a.kpis.roas ?? Number.POSITIVE_INFINITY) - (b.kpis.roas ?? Number.POSITIVE_INFINITY)
    );

    const recommendations = {
      reallocate_from: byRoasAsc.slice(0, 5),
      reallocate_to: byRoasDesc.slice(0, 5),
    };

    return { raw_data: rows, analysis: { allocation, totalSpend }, recommendations };
  }

  // Conversion Tracking & Funnel
  async analyze_conversion_funnel(input: {
    ad_account_id?: string;
    date_range: DateRange;
    attribution_window_days?: number;
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const fields = ["spend", "impressions", "clicks", "actions", "action_values"];

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level: "account",
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const agg: Record<"view_content" | "add_to_cart" | "initiate_checkout" | "purchase", number> = {
      view_content: 0,
      add_to_cart: 0,
      initiate_checkout: 0,
      purchase: 0,
    };

    let spend = 0;
    let imp = 0;
    let clk = 0;
    let revenue = 0;

    for (const r of rows) {
      spend += toNumber(r.spend);
      imp += toNumber(r.impressions);
      clk += toNumber(r.clicks);

      for (const a of getActions(r)) {
        const t = String(a.action_type ?? "");
        if (t === "view_content") agg.view_content += toNumber(a.value);
        if (t === "add_to_cart") agg.add_to_cart += toNumber(a.value);
        if (t === "initiate_checkout") agg.initiate_checkout += toNumber(a.value);
        if (t === "purchase") agg.purchase += toNumber(a.value);
      }
      revenue += purchaseValue(r);
    }

    const funnel = [
      { stage: "ViewContent", count: agg.view_content },
      { stage: "AddToCart", count: agg.add_to_cart },
      { stage: "InitiateCheckout", count: agg.initiate_checkout },
      { stage: "Purchase", count: agg.purchase },
    ];
    const dropoffs = funnel.map((f, i) => (i === 0 ? 0 : round2(1 - f.count / Math.max(funnel[i - 1].count, 1e-9))));
    const kpis = computeSpendKpis(spend, imp, clk, agg.purchase, revenue);

    const recommendations = {
      focus_stage: dropoffs.indexOf(Math.max(...dropoffs)),
      suggestions: ["Tighten audience at the largest drop stage", "Test landing page changes", "Check pixel mapping for missing events"],
    };

    return { raw_data: rows, analysis: { funnel, dropoffs, kpis }, recommendations };
  }

  // Competitive Intelligence / Delivery Insights
  async get_ad_delivery_insights(input: {
    ad_account_id?: string;
    date_range: DateRange;
    placements?: string[];
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);

    // IMPORTANT: do NOT include breakdowns as fields; use them only in `breakdowns`.
    const fields = ["spend", "impressions", "clicks"];
    const breakdowns = ["publisher_platform", "platform_position"];

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level: "ad",
      breakdowns,
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    const key = (r: AnyRow): string =>
      `${String(r.publisher_platform ?? "")}|${String(r.platform_position ?? "")}`;

    const byKey = new Map<string, { spend: number; imp: number; clk: number }>();
    for (const r of rows) {
      const k = key(r);
      const cur = byKey.get(k) || { spend: 0, imp: 0, clk: 0 };
      cur.spend += toNumber(r.spend);
      cur.imp += toNumber(r.impressions);
      cur.clk += toNumber(r.clicks);
      byKey.set(k, cur);
    }

    let items = Array.from(byKey.entries()).map(([k, v]) => {
      const [platform, position] = k.split("|");
      const kpis = computeSpendKpis(v.spend, v.imp, v.clk);
      return { platform, position, kpis };
    });

    // Optional filtering by placements (platform names), applied post-query
    if (input.placements?.length) {
      const set = new Set(input.placements.map((p) => p.toLowerCase()));
      items = items.filter((x) => set.has(String(x.platform).toLowerCase()));
    }

    items.sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));

    const recommendations = {
      shift_impressions_to: items.slice(0, 3),
      reduce_in: items.slice(-3),
    };

    return { raw_data: rows, analysis: { items }, recommendations };
  }

  // ROI & Attribution (basic)
  async calculate_advanced_attribution(input: {
    ad_account_id?: string;
    date_range: DateRange;
    assumed_ltv?: number;
    cac_target?: number;
  }): Promise<ToolResult> {
    const accountId = this.accountIdOrThrow(input.ad_account_id);
    const fields = ["spend", "actions", "action_values"];

    const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
      fields,
      time_range: input.date_range,
      level: "account",
    });
    const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

    let spend = 0;
    let purchases = 0;
    let revenue = 0;

    for (const r of rows) {
      spend += toNumber(r.spend);
      purchases += toNumber(getActions(r).find((a: AnyRow) => a.action_type === "purchase")?.value);
      revenue += toNumber(getActionValues(r).find((a: AnyRow) => a.action_type === "purchase")?.value);
    }

    const cac = purchases > 0 ? round2(spend / purchases) : 0;
    const roas = spend > 0 ? round2(revenue / spend) : 0;
    const ltv = input.assumed_ltv ?? (purchases > 0 ? round2(revenue / Math.max(purchases, 1)) * 3 : 0);
    const clv_to_cac = cac > 0 ? round2(ltv / cac) : 0;

    const recommendations = {
      cac_ok: input.cac_target != null ? cac <= input.cac_target : undefined,
      notes: [
        "For true multi-touch attribution, export event-level data to a DWH and compute modeled credit.",
        "Validate attribution setting in the account and ensure pixel deduping is configured.",
      ],
    };

    return {
      raw_data: rows,
      analysis: { spend, purchases, revenue, cac, roas, ltv, clv_to_cac },
      recommendations,
    };
  }
}










// import { MetaApi } from "./meta.js";
// import { DateRange, MetaConfig, ToolResult } from "./types.js";
// import { computeSpendKpis, round2, toNumber } from "./utils.js";

// type AnyRow = Record<string, any>;
// type KPIs = ReturnType<typeof computeSpendKpis>;

// const getActions = (r: AnyRow): AnyRow[] =>
//   Array.isArray(r.actions) ? (r.actions as AnyRow[]) : [];

// const getActionValues = (r: AnyRow): AnyRow[] =>
//   Array.isArray(r.action_values) ? (r.action_values as AnyRow[]) : [];

// const purchaseCount = (r: AnyRow): number =>
//   toNumber(getActions(r).find((a: AnyRow) => String(a.action_type ?? "").includes("purchase"))?.value);

// const purchaseValue = (r: AnyRow): number =>
//   toNumber(getActionValues(r).find((a: AnyRow) => String(a.action_type ?? "").includes("purchase"))?.value);

// export class MetaAdsTools {
//   private api: MetaApi;

//   constructor(private cfg: MetaConfig) {
//     this.api = new MetaApi(cfg);
//   }

//   // --- helper: normalize ad account id ---
//   private accountIdOrThrow(adAccountId?: string): string {
//     const raw = adAccountId || this.cfg.adAccountId;
//     if (!raw || !raw.trim()) {
//       throw new Error(
//         "ad_account_id is required. Set META_AD_ACCOUNT_ID in .env or pass ad_account_id in the tool input."
//       );
//     }
//     const id = raw.trim();
//     return id.startsWith("act_") ? id : `act_${id}`;
//   }

//   // Admin: list ad accounts available for the token (no business field to avoid business_management)
//   async list_accounts(): Promise<ToolResult> {
//     const me: AnyRow = await this.api.get("/me", { fields: ["id", "name"] });

//     const baseFields = ["id", "account_id", "name", "currency", "timezone_name"];
//     let accounts: AnyRow[] = [];
//     try {
//       accounts = await this.api.getAllPages(`/me/adaccounts`, { fields: baseFields });
//     } catch (err: any) {
//       throw new Error(`Failed to list ad accounts: ${err?.message || String(err)}`);
//     }

//     return { raw_data: { me, accounts } };
//   }

//   // Account Overview
//   async get_account_performance_summary(input: {
//     ad_account_id?: string;
//     date_range: DateRange;
//     currency?: string;
//     attribution_setting?: string;
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["spend", "impressions", "clicks", "actions", "action_values", "objective", "reach"];

//     const params: Record<string, any> = {
//       fields,
//       time_range: input.date_range,
//       level: "account",
//       breakdowns: [],
//       time_increment: 1,
//     };

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, params);
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const spend = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.spend), 0);
//     const impressions = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.impressions), 0);
//     const clicks = rows.reduce((s: number, r: AnyRow) => s + toNumber(r.clicks), 0);

//     let conversions = 0;
//     let revenue = 0;
//     for (const r of rows) {
//       conversions += purchaseCount(r);
//       revenue += purchaseValue(r);
//     }

//     const kpis = computeSpendKpis(spend, impressions, clicks, conversions || undefined, revenue || undefined);
//     const analysis = {
//       kpis,
//       days: rows.length,
//       objectives: Array.from(new Set(rows.map((x: AnyRow) => x.objective).filter(Boolean) as string[])),
//     };

//     const recommendations = {
//       note: "Validate pixel/conversions mapping to ensure accurate CPA/ROAS. Consider narrowing fields to speed up responses.",
//     };

//     return { raw_data: rows, analysis, recommendations, meta: { accountId } };
//   }

//   // Campaign Analytics
//   async analyze_campaign_performance(input: {
//     ad_account_id?: string;
//     campaign_ids?: string[];
//     date_range: DateRange;
//     performance_thresholds?: { cpa?: number; roas?: number };
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["campaign_id", "campaign_name", "spend", "impressions", "clicks", "actions", "action_values"];
//     const filtering: AnyRow[] | undefined = input.campaign_ids?.length
//       ? [{ field: "campaign.id", operator: "IN", value: input.campaign_ids }]
//       : undefined;

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level: "campaign",
//       filtering,
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const enriched: (AnyRow & { kpis: KPIs })[] = rows.map((r: AnyRow) => {
//       const spend = toNumber(r.spend);
//       const imp = toNumber(r.impressions);
//       const clk = toNumber(r.clicks);
//       const conv = purchaseCount(r);
//       const rev = purchaseValue(r);
//       const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);
//       return { ...r, kpis: k };
//     });

//     const rankedByRoas = [...enriched].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));
//     const rankedByCpa = [...enriched].sort(
//       (a, b) => (a.kpis.cpa ?? Number.POSITIVE_INFINITY) - (b.kpis.cpa ?? Number.POSITIVE_INFINITY)
//     );

//     const thresholds = input.performance_thresholds || {};
//     const underperformers = enriched.filter((r) => {
//       const roas = r.kpis.roas ?? 0;
//       const cpa = r.kpis.cpa ?? Number.POSITIVE_INFINITY;
//       const failRoas = thresholds.roas != null && roas < thresholds.roas;
//       const failCpa = thresholds.cpa != null && cpa > thresholds.cpa;
//       return failRoas || failCpa;
//     });

//     const recommendations = {
//       reallocate_budget_from: underperformers.slice(0, 5).map((r) => ({
//         id: r.campaign_id,
//         name: r.campaign_name,
//         kpis: r.kpis,
//       })),
//       to_top_campaigns: rankedByRoas.slice(0, 5).map((r) => ({
//         id: r.campaign_id,
//         name: r.campaign_name,
//         kpis: r.kpis,
//       })),
//     };

//     return { raw_data: rows, analysis: { rankedByRoas, rankedByCpa }, recommendations };
//   }

//   // Audience Insights
//   async get_audience_performance_breakdown(input: {
//     ad_account_id?: string;
//     level?: "adset" | "campaign";
//     ids?: string[];
//     date_range: DateRange;
//     breakdowns?: string[];
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const level = input.level || "adset";
//     const fields = ["spend", "impressions", "clicks", "actions", "action_values", `${level}_id`, `${level}_name`];
//     const filtering: AnyRow[] | undefined = input.ids?.length
//       ? [{ field: `${level}.id`, operator: "IN", value: input.ids }]
//       : undefined;
//     const breakdowns = input.breakdowns?.length ? input.breakdowns : ["age", "gender", "publisher_platform"];

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level,
//       breakdowns,
//       filtering,
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const byKey = new Map<
//       string,
//       { spend: number; impressions: number; clicks: number; conversions: number; revenue: number }
//     >();
//     for (const r of rows) {
//       const key = breakdowns.map((b) => String((r as AnyRow)[b] ?? "")).join("|");
//       const cur = byKey.get(key) ?? { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
//       cur.spend += toNumber(r.spend);
//       cur.impressions += toNumber(r.impressions);
//       cur.clicks += toNumber(r.clicks);
//       cur.conversions += purchaseCount(r);
//       cur.revenue += purchaseValue(r);
//       byKey.set(key, cur);
//     }

//     const result = Array.from(byKey.entries()).map(([k, v]) => ({
//       key: k,
//       kpis: computeSpendKpis(v.spend, v.impressions, v.clicks, v.conversions, v.revenue),
//     }));
//     const ranked = result.sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));

//     return { raw_data: rows, analysis: { breakdowns, ranked } };
//   }

//   // Creative Performance
//   async analyze_creative_effectiveness(input: {
//     ad_account_id?: string;
//     ad_ids?: string[];
//     date_range: DateRange;
//     include_preview?: boolean;
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["ad_id", "ad_name", "spend", "impressions", "clicks", "actions", "action_values", "creative"];
//     const filtering: AnyRow[] | undefined = input.ad_ids?.length
//       ? [{ field: "ad.id", operator: "IN", value: input.ad_ids }]
//       : undefined;

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level: "ad",
//       filtering,
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const items = rows.map((r: AnyRow) => {
//       const spend = toNumber(r.spend);
//       const imp = toNumber(r.impressions);
//       const clk = toNumber(r.clicks);
//       const conv = purchaseCount(r);
//       const rev = purchaseValue(r);
//       const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);

//       const creative: AnyRow | undefined = r.creative as AnyRow | undefined;
//       const objSpec: AnyRow | undefined = creative?.object_story_spec as AnyRow | undefined;
//       const creativeType = objSpec?.video_data ? "video" : objSpec?.link_data ? "image" : "unknown";

//       return { id: r.ad_id, name: r.ad_name, creativeType, kpis: k };
//     });

//     const byType: Record<string, { spend: number; imp: number; clk: number; conv: number; rev: number }> = {};
//     for (const it of items) {
//       const acc = byType[it.creativeType] || { spend: 0, imp: 0, clk: 0, conv: 0, rev: 0 };
//       acc.spend += it.kpis.spend;
//       acc.imp += it.kpis.impressions;
//       acc.clk += it.kpis.clicks;
//       acc.conv += it.kpis.conversions || 0;
//       acc.rev += it.kpis.revenue || 0;
//       byType[it.creativeType] = acc;
//     }

//     const typeSummary = Object.entries(byType).map(([t, v]) => ({
//       type: t,
//       kpis: computeSpendKpis(v.spend, v.imp, v.clk, v.conv, v.rev),
//     }));

//     const recommendations = {
//       top_creatives: [...items].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0)).slice(0, 5),
//       test_suggestions: ["Test new variants of the top performer format", "Rotate out creatives with low CTR and high CPA"],
//     };

//     return { raw_data: rows, analysis: { items, typeSummary }, recommendations };
//   }

//   // Budget Optimization
//   async get_spend_allocation_insights(input: {
//     ad_account_id?: string;
//     date_range: DateRange;
//     level?: "campaign" | "adset" | "ad";
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const level = input.level || "campaign";
//     const fields = [`${level}_id`, `${level}_name`, "spend", "impressions", "clicks", "actions", "action_values"];

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level,
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const items = rows.map((r: AnyRow) => {
//       const spend = toNumber(r.spend);
//       const imp = toNumber(r.impressions);
//       const clk = toNumber(r.clicks);
//       const conv = purchaseCount(r);
//       const rev = purchaseValue(r);
//       const k = computeSpendKpis(spend, imp, clk, conv || undefined, rev || undefined);
//       const id = String(r[`${level}_id`]);
//       const name = String(r[`${level}_name`]);
//       return { id, name, kpis: k };
//     });

//     const totalSpend = items.reduce((s: number, x: { kpis: KPIs }) => s + x.kpis.spend, 0);
//     const allocation = items.map((x) => ({
//       ...x,
//       spend_share: round2((x.kpis.spend / Math.max(totalSpend, 1e-9)) * 100),
//     }));

//     const byRoasDesc = [...allocation].sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));
//     const byRoasAsc = [...allocation].sort(
//       (a, b) => (a.kpis.roas ?? Number.POSITIVE_INFINITY) - (b.kpis.roas ?? Number.POSITIVE_INFINITY)
//     );

//     const recommendations = {
//       reallocate_from: byRoasAsc.slice(0, 5),
//       reallocate_to: byRoasDesc.slice(0, 5),
//     };

//     return { raw_data: rows, analysis: { allocation, totalSpend }, recommendations };
//   }

//   // Conversion Tracking & Funnel
//   async analyze_conversion_funnel(input: {
//     ad_account_id?: string;
//     date_range: DateRange;
//     attribution_window_days?: number;
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["spend", "impressions", "clicks", "actions", "action_values"];

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level: "account",
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const agg: Record<"view_content" | "add_to_cart" | "initiate_checkout" | "purchase", number> = {
//       view_content: 0,
//       add_to_cart: 0,
//       initiate_checkout: 0,
//       purchase: 0,
//     };

//     let spend = 0;
//     let imp = 0;
//     let clk = 0;
//     let revenue = 0;

//     for (const r of rows) {
//       spend += toNumber(r.spend);
//       imp += toNumber(r.impressions);
//       clk += toNumber(r.clicks);

//       for (const a of getActions(r)) {
//         const t = String(a.action_type ?? "");
//         if (t === "view_content") agg.view_content += toNumber(a.value);
//         if (t === "add_to_cart") agg.add_to_cart += toNumber(a.value);
//         if (t === "initiate_checkout") agg.initiate_checkout += toNumber(a.value);
//         if (t === "purchase") agg.purchase += toNumber(a.value);
//       }
//       revenue += purchaseValue(r);
//     }

//     const funnel = [
//       { stage: "ViewContent", count: agg.view_content },
//       { stage: "AddToCart", count: agg.add_to_cart },
//       { stage: "InitiateCheckout", count: agg.initiate_checkout },
//       { stage: "Purchase", count: agg.purchase },
//     ];
//     const dropoffs = funnel.map((f, i) => (i === 0 ? 0 : round2(1 - f.count / Math.max(funnel[i - 1].count, 1e-9))));
//     const kpis = computeSpendKpis(spend, imp, clk, agg.purchase, revenue);

//     const recommendations = {
//       focus_stage: dropoffs.indexOf(Math.max(...dropoffs)),
//       suggestions: ["Tighten audience at the largest drop stage", "Test landing page changes", "Check pixel mapping for missing events"],
//     };

//     return { raw_data: rows, analysis: { funnel, dropoffs, kpis }, recommendations };
//   }

//   // Competitive Intelligence / Delivery Insights
//   async get_ad_delivery_insights(input: {
//     ad_account_id?: string;
//     date_range: DateRange;
//     placements?: string[];
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["spend", "impressions", "clicks", "publisher_platform", "platform_position"];
//     const breakdowns = ["publisher_platform", "platform_position"];

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level: "ad",
//       breakdowns,
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     const key = (r: AnyRow): string =>
//       `${String(r.publisher_platform ?? "")}|${String(r.platform_position ?? "")}`;

//     const byKey = new Map<string, { spend: number; imp: number; clk: number }>();
//     for (const r of rows) {
//       const k = key(r);
//       const cur = byKey.get(k) || { spend: 0, imp: 0, clk: 0 };
//       cur.spend += toNumber(r.spend);
//       cur.imp += toNumber(r.impressions);
//       cur.clk += toNumber(r.clicks);
//       byKey.set(k, cur);
//     }

//     const items = Array.from(byKey.entries())
//       .map(([k, v]) => {
//         const [platform, position] = k.split("|");
//         const kpis = computeSpendKpis(v.spend, v.imp, v.clk);
//         return { platform, position, kpis };
//       })
//       .sort((a, b) => (b.kpis.roas ?? 0) - (a.kpis.roas ?? 0));

//     const recommendations = {
//       shift_impressions_to: items.slice(0, 3),
//       reduce_in: items.slice(-3),
//     };

//     return { raw_data: rows, analysis: { items }, recommendations };
//   }

//   // ROI & Attribution (basic)
//   async calculate_advanced_attribution(input: {
//     ad_account_id?: string;
//     date_range: DateRange;
//     assumed_ltv?: number;
//     cac_target?: number;
//   }): Promise<ToolResult> {
//     const accountId = this.accountIdOrThrow(input.ad_account_id);
//     const fields = ["spend", "actions", "action_values"];

//     const resp: AnyRow = await this.api.get(`/${accountId}/insights`, {
//       fields,
//       time_range: input.date_range,
//       level: "account",
//     });
//     const rows: AnyRow[] = (resp.data as AnyRow[]) ?? [];

//     let spend = 0;
//     let purchases = 0;
//     let revenue = 0;

//     for (const r of rows) {
//       spend += toNumber(r.spend);
//       purchases += toNumber(getActions(r).find((a: AnyRow) => a.action_type === "purchase")?.value);
//       revenue += toNumber(getActionValues(r).find((a: AnyRow) => a.action_type === "purchase")?.value);
//     }

//     const cac = purchases > 0 ? round2(spend / purchases) : 0;
//     const roas = spend > 0 ? round2(revenue / spend) : 0;
//     const ltv = input.assumed_ltv ?? (purchases > 0 ? round2(revenue / Math.max(purchases, 1)) * 3 : 0);
//     const clv_to_cac = cac > 0 ? round2(ltv / cac) : 0;

//     const recommendations = {
//       cac_ok: input.cac_target != null ? cac <= input.cac_target : undefined,
//       notes: [
//         "For true multi-touch attribution, export event-level data to a DWH and compute modeled credit.",
//         "Validate attribution setting in the account and ensure pixel deduping is configured.",
//       ],
//     };

//     return {
//       raw_data: rows,
//       analysis: { spend, purchases, revenue, cac, roas, ltv, clv_to_cac },
//       recommendations,
//     };
//   }
// }

