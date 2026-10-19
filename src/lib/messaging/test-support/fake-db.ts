/**
 * Minimal in-memory Drizzle stand-in for behavior tests that need real
 * query-flow decisions (two accounts, legacy fallback, route aggregation)
 * without a database. It supports only the shapes this codebase uses:
 * select/from/where/limit/orderBy, insert/values/returning/onConflictDoNothing,
 * update/set/where, and the eq/and/or/is-null/in-array predicates.
 */

import { getTableName } from "drizzle-orm";

type Row = Record<string, unknown>;

interface SqlNode {
  queryChunks?: unknown[];
  name?: string;
}

interface ParamNode {
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isSqlNode(value: unknown): value is SqlNode {
  return isRecord(value) && Array.isArray(value.queryChunks);
}

function isColumn(value: unknown): value is { name: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    "table" in value
  );
}

function textOf(node: SqlNode): string {
  const chunks = node.queryChunks ?? [];
  let text = "";
  for (const chunk of chunks) {
    if (isRecord(chunk) && Array.isArray(chunk.value)) {
      text += chunk.value.join("");
    }
  }
  return text;
}

function collect<T>(
  node: SqlNode,
  match: (value: unknown) => value is T,
  out: T[] = []
): T[] {
  for (const chunk of node.queryChunks ?? []) {
    if (match(chunk)) out.push(chunk);
    if (isSqlNode(chunk)) collect(chunk, match, out);
  }
  return out;
}

function isParam(value: unknown): value is ParamNode {
  return isRecord(value) && "value" in value && "encoder" in value;
}

function firstColumn(node: SqlNode): { name: string } | undefined {
  return collect(node, isColumn)[0];
}

function paramsOf(node: SqlNode): unknown[] {
  return collect(node, isParam).map((param) => param.value);
}

function listValuesOf(node: SqlNode): unknown[] {
  return collect(node, Array.isArray as (value: unknown) => value is unknown[])
    .flat()
    .map((value) => (isParam(value) ? value.value : value));
}

/** Drizzle column names are snake_case; plain row objects are camelCase. */
function valueOf(row: Row, column: { name: string }): unknown {
  if (column.name in row) return row[column.name];
  const camel = column.name.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase()
  );
  return row[camel];
}

function evaluate(expr: unknown, row: Row): boolean {
  if (!isSqlNode(expr)) return true;
  const text = textOf(expr).toLowerCase();
  const nested = (expr.queryChunks ?? []).filter(isSqlNode);

  if (/\s+and\s+/.test(text)) return nested.every((child) => evaluate(child, row));
  if (/\s+or\s+/.test(text)) return nested.some((child) => evaluate(child, row));

  const column = firstColumn(expr);
  const columns = collect(expr, isColumn);
  const params = paramsOf(expr);
  if (/\bis\s+not\s+null\b/.test(text)) {
    return column ? valueOf(row, column) != null : true;
  }
  if (/\bis\s+null\b/.test(text)) {
    return column ? valueOf(row, column) == null : true;
  }
  if (/\bin\b/.test(text)) {
    const values = [...params, ...listValuesOf(expr)];
    return column ? values.some((value) => valueOf(row, column) === value) : true;
  }
  if (text.includes("=")) {
    if (!column) return true;
    if (params.length > 0) return valueOf(row, column) === params[0];
    if (columns.length > 1) {
      return valueOf(row, columns[0]) === valueOf(row, columns[1]);
    }
    return true;
  }
  if (nested.length === 1) return evaluate(nested[0], row);
  return true;
}

function uniqueKeys(table: string, row: Row): string[] {
  const keys: string[] = [];
  if (table === "conversations") {
    if (row.whatsappId) keys.push(`wa:${String(row.whatsappId)}`);
    if (row.externalUserIdNormalized && row.channelAccountId != null) {
      keys.push(
        `acc:${String(row.channel)}|${String(row.channelAccountId)}|${String(
          row.externalUserIdNormalized
        )}`
      );
    }
    if (row.externalUserIdNormalized && row.channelAccountId == null) {
      keys.push(
        `legacy:${String(row.channel)}|${String(
          row.externalUserIdNormalized
        )}`
      );
    }
  }
  if (table === "chat_messages" && row.platformMessageId) {
    keys.push(`platform:${String(row.platformMessageId)}`);
  }
  if (table === "channel_events" && row.deliveryId) {
    // Mirrors channel_events_provider_delivery_uq (migration 0019):
    // (provider, coalesce(channel_account_id, -1), delivery_id).
    keys.push(
      `delivery:${String(row.provider)}|${String(row.channelAccountId ?? -1)}|${String(row.deliveryId)}`
    );
  }
  return keys;
}

class QueryBuilder implements PromiseLike<unknown> {
  private readonly db: FakeDb;
  private readonly op: "select" | "insert" | "update";
  private table: string;
  private whereExpr: unknown;
  private limitCount: number | undefined;
  private readonly joins: { table: string; condition: unknown }[] = [];
  private inserted: Row | undefined;
  private updated: Row | undefined;
  private ignoreConflict = false;

  constructor(db: FakeDb, op: QueryBuilder["op"], table: string) {
    this.db = db;
    this.op = op;
    this.table = table;
  }

  from(table: unknown): this {
    this.table = getTableName(table as never);
    return this;
  }

  innerJoin(table: unknown, condition: unknown): this {
    this.joins.push({ table: getTableName(table as never), condition });
    return this;
  }

  where(expr: unknown): this {
    this.whereExpr = expr;
    return this;
  }

  orderBy(..._columns: unknown[]): this {
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  values(values: Row): this {
    this.inserted = values;
    return this;
  }

  set(values: Row): this {
    this.updated = values;
    return this;
  }

  returning(..._columns: unknown[]): this {
    return this;
  }

  onConflictDoNothing(): this {
    this.ignoreConflict = true;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<Row[]> {
    if (this.op === "select") {
      let rows = this.db.rows(this.table);
      for (const join of this.joins) {
        const joined = this.db.rows(join.table);
        rows = rows.flatMap((base) =>
          joined
            .map((other) => ({ ...base, ...other }))
            .filter((row) => evaluate(join.condition, row))
        );
      }
      rows = rows.filter((row) => evaluate(this.whereExpr, row));
      return this.limitCount != null ? rows.slice(0, this.limitCount) : rows;
    }
    if (this.op === "insert") {
      try {
        return [this.db.insert(this.table, this.inserted ?? {})];
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (this.ignoreConflict && code === "23505") return [];
        throw error;
      }
    }
    return this.db.update(this.table, this.updated ?? {}, this.whereExpr);
  }
}

export class FakeDb {
  private readonly tables = new Map<string, Row[]>();
  private readonly sequences = new Map<string, number>();

  seed(table: unknown, rows: Row[]): void {
    const name = getTableName(table as never);
    this.tables.set(name, rows.map((row) => ({ ...row })));
    const max = rows.reduce(
      (current, row) => Math.max(current, Number(row.id ?? 0)),
      0
    );
    this.sequences.set(name, max);
  }

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  insert(table: string, values: Row): Row {
    if (!this.tables.has(table)) this.tables.set(table, []);
    const rows = this.rows(table);
    const keys = uniqueKeys(table, values);
    for (const row of rows) {
      const existing = uniqueKeys(table, row);
      if (keys.some((key) => existing.includes(key))) {
        const error = new Error("duplicate key value violates unique constraint") as Error & {
          code?: string;
        };
        error.code = "23505";
        throw error;
      }
    }
    const id = values.id ?? (this.sequences.get(table) ?? 0) + 1;
    this.sequences.set(table, Number(id));
    const row = { ...values, id };
    rows.push(row);
    return row;
  }

  update(table: string, values: Row, whereExpr: unknown): Row[] {
    const updated: Row[] = [];
    for (const row of this.rows(table)) {
      if (!evaluate(whereExpr, row)) continue;
      Object.assign(row, values);
      updated.push(row);
    }
    return updated;
  }

  select(): QueryBuilder {
    return new QueryBuilder(this, "select", "");
  }

  insertInto(table: unknown): QueryBuilder {
    return new QueryBuilder(this, "insert", getTableName(table as never));
  }

  updateTable(table: unknown): QueryBuilder {
    return new QueryBuilder(this, "update", getTableName(table as never));
  }
}

/** Install a fake `@/db` before the modules under test are required. */
export function installFakeDb(fake: FakeDb): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = Module._load;
  Module._load = function (
    request: string,
    parent: unknown,
    isMain: boolean
  ): unknown {
    if (request === "@/db") {
      return {
        db: {
          select: () => fake.select(),
          insert: (table: unknown) => fake.insertInto(table),
          update: (table: unknown) => fake.updateTable(table),
        },
        getDb: () => fake,
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = original;
  };
}
