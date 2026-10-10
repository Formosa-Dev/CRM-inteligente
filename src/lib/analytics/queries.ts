import { sql, gte, desc, count } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SummaryStats {
  totalLeads: number;
  leadsThisWeek: number;
  topCampaign: string | null;
  conversionRate: number;
}

export interface DailyLeads {
  date: string; // YYYY-MM-DD
  count: number;
  source: string | null;
}

export interface CampaignPerformance {
  campaign: string;
  leadCount: number;
  convertedCount: number;
  rate: number;
}

// ─── getSummaryStats ──────────────────────────────────────────────────────────

/**
 * Returns aggregate stats:
 * - totalLeads: all-time count
 * - leadsThisWeek: leads created in the last 7 days
 * - topCampaign: utm_campaign with the most leads (null if no campaign data)
 * - conversionRate: fraction of leads with status "converted" (0–1)
 */
export async function getSummaryStats(): Promise<SummaryStats> {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  // Total leads + converted count in a single pass
  const [totals] = await db
    .select({
      totalLeads: count(),
      convertedCount: sql<number>`cast(sum(case when ${leads.status} = 'converted' then 1 else 0 end) as int)`,
    })
    .from(leads);

  // Leads created in the last 7 days
  const [weekRow] = await db
    .select({ leadsThisWeek: count() })
    .from(leads)
    .where(gte(leads.createdAt, oneWeekAgo));

  // Top campaign by lead count
  const topCampaignRows = await db
    .select({
      campaign: leads.utmCampaign,
      leadCount: count(),
    })
    .from(leads)
    .where(sql`${leads.utmCampaign} is not null`)
    .groupBy(leads.utmCampaign)
    .orderBy(desc(count()))
    .limit(1);

  const total = totals?.totalLeads ?? 0;
  const converted = totals?.convertedCount ?? 0;
  const thisWeek = weekRow?.leadsThisWeek ?? 0;
  const topCampaign = topCampaignRows[0]?.campaign ?? null;

  return {
    totalLeads: total,
    leadsThisWeek: thisWeek,
    topCampaign,
    conversionRate: total > 0 ? converted / total : 0,
  };
}

// ─── getLeadsByDay ────────────────────────────────────────────────────────────

/**
 * Returns lead counts per day for the last `days` days, grouped by utm_source.
 * Each row is { date: "YYYY-MM-DD", count, source }.
 */
export async function getLeadsByDay(days: number): Promise<DailyLeads[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows = await db
    .select({
      date: sql<string>`to_char(${leads.createdAt}, 'YYYY-MM-DD')`,
      count: sql<number>`cast(count(*) as int)`,
      source: leads.utmSource,
    })
    .from(leads)
    .where(gte(leads.createdAt, since))
    .groupBy(sql`to_char(${leads.createdAt}, 'YYYY-MM-DD')`, leads.utmSource)
    .orderBy(sql`to_char(${leads.createdAt}, 'YYYY-MM-DD')`);

  return rows.map((r) => ({
    date: r.date,
    count: r.count,
    source: r.source ?? null,
  }));
}

// ─── getCampaignPerformance ───────────────────────────────────────────────────

/**
 * Returns per-campaign stats sorted by leadCount descending.
 * Only includes leads where utm_campaign is not null.
 * rate = convertedCount / leadCount (0–1).
 */
export async function getCampaignPerformance(): Promise<CampaignPerformance[]> {
  const rows = await db
    .select({
      campaign: leads.utmCampaign,
      leadCount: sql<number>`cast(count(*) as int)`,
      convertedCount: sql<number>`cast(sum(case when ${leads.status} = 'converted' then 1 else 0 end) as int)`,
    })
    .from(leads)
    .where(sql`${leads.utmCampaign} is not null`)
    .groupBy(leads.utmCampaign)
    .orderBy(desc(sql`count(*)`));

  return rows.map((r) => {
    const leadCount = r.leadCount ?? 0;
    const convertedCount = r.convertedCount ?? 0;
    return {
      campaign: r.campaign as string,
      leadCount,
      convertedCount,
      rate: leadCount > 0 ? convertedCount / leadCount : 0,
    };
  });
}
