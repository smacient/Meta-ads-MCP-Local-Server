export type MetaConfig = {
appId: string;
appSecret: string;
accessToken: string;
adAccountId: string; // "act_123..."
businessId?: string;
apiVersion: string; // e.g., "v20.0"
};


export type DateRange = { since: string; until: string }; // YYYY-MM-DD


export type ToolResult<T = unknown> = {
raw_data: unknown;
analysis?: T;
recommendations?: unknown;
meta?: Record<string, unknown>;
};


export type SpendKpis = {
spend: number;
impressions: number;
clicks: number;
conversions?: number;
ctr?: number;
cpc?: number;
cpm?: number;
cpa?: number;
roas?: number;
revenue?: number;
};

