import { request } from "undici";
import { MetaConfig } from "./types.js";
import { delay } from "./utils.js";

export class MetaApi {
  constructor(private cfg: MetaConfig) {}

  private baseUrl(): string {
    const v = this.cfg.apiVersion || "v20.0";
    return `https://graph.facebook.com/${v}`;
  }

  private withAuth(params: Record<string, any>): Record<string, any> {
    return { access_token: this.cfg.accessToken, ...params };
  }

  async get<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    const url = new URL(this.baseUrl() + path);
    const all = this.withAuth(params);
    Object.entries(all).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) url.searchParams.set(k, v.join(","));
      else if (typeof v === "object") url.searchParams.set(k, JSON.stringify(v));
      else url.searchParams.set(k, String(v));
    });
    const res = await request(url.toString(), { method: "GET" });
    const body: any = await res.body.json();
    if (body?.error) throw new Error(JSON.stringify(body.error));
    return body as T;
  }

  async getAllPages<T = any>(path: string, params: Record<string, any> = {}): Promise<any[]> {
    let url = new URL(this.baseUrl() + path);
    const all = this.withAuth(params);
    Object.entries(all).forEach(([k, v]) => {
      if (v == null) return;
      if (Array.isArray(v)) url.searchParams.set(k, v.join(","));
      else if (typeof v === "object") url.searchParams.set(k, JSON.stringify(v));
      else url.searchParams.set(k, String(v));
    });
    const out: any[] = [];
    // paginate
    while (true) {
      const res = await request(url.toString(), { method: "GET" });
      const body: any = await res.body.json();
      if (body?.error) throw new Error(JSON.stringify(body.error));
      const data = body.data ?? [];
      out.push(...data);
      const next = body.paging?.next;
      if (!next) break;
      url = new URL(next);
    }
    return out;
  }

  // Optional async insights helper (ensure endpoints & params match your needs)
  async runInsightsJob(adAccountId: string, params: Record<string, any>, pollMs = 1500, maxWaitMs = 120000) {
    // Start job (POST is typical for async; leaving as GET if you’ve tested it)
    const job: any = await this.get(`/${adAccountId}/insights`, { ...params, async: "true" });
    const jobId = job.report_run_id ?? job.report_run?.id;
    if (!jobId) throw new Error("Failed to start insights async job");

    const start = Date.now();
    while (true) {
      const status: any = await this.get(`/${jobId}`, {});
      const s = status.async_status || status.status;
      if (s === "Job Completed") break;
      if (s === "Job Failed" || s === "Error") throw new Error("Async insights job failed");
      if (Date.now() - start > maxWaitMs) throw new Error("Async insights timed out");
      await delay(pollMs);
    }
    const result = await this.get(`/${jobId}/insights`, {});
    return result;
    }
}
