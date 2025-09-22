// src/utils.ts
import type { SpendKpis } from "./types.js";

export const toNumber = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export const safeDiv = (num: number, den: number): number => {
  return den === 0 ? 0 : num / den;
};

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeSpendKpis(
  spend: number,
  impressions: number,
  clicks: number,
  conversions?: number,
  revenue?: number
): SpendKpis {
  const ctr = safeDiv(clicks, impressions);
  const cpc = safeDiv(spend, Math.max(clicks, 1));
  const cpm = safeDiv(spend, Math.max(impressions, 1)) * 1000;
  const cpa = conversions != null ? safeDiv(spend, Math.max(conversions, 1)) : undefined;
  const roas = revenue != null && revenue > 0 ? safeDiv(revenue, Math.max(spend, 1e-9)) : undefined;

  return {
    spend: round2(spend),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    conversions: conversions != null ? Math.round(conversions) : undefined,
    ctr: round2(ctr),
    cpc: round2(cpc),
    cpm: round2(cpm),
    cpa: cpa != null ? round2(cpa) : undefined,
    roas: roas != null ? round2(roas) : undefined,
    revenue: revenue != null ? round2(revenue) : undefined
  };
}

// Simple async sleep/backoff
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
