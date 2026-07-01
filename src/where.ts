import { isOperator, type Operator } from "./operators.js";
import type { RecordShape } from "./types.js";

export type WhereValue<TValue> = TValue | readonly TValue[] | Operator<TValue> | Operator<null>;

export type SqlExpression =
  | {
      readonly type: "sql-expression";
      readonly kind: "field";
      readonly field: string;
    }
  | {
      readonly type: "sql-expression";
      readonly kind: "value";
      readonly value: unknown;
    }
  | {
      readonly type: "sql-expression";
      readonly kind: "aggregate";
      readonly fn: "sum" | "count";
      readonly expression: SqlExpression;
      readonly where?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "sql-expression";
      readonly kind: "binary";
      readonly operator: "+" | "-" | "*" | "/";
      readonly left: SqlExpression;
      readonly right: SqlExpression;
    }
  | {
      readonly type: "sql-expression";
      readonly kind: "coalesce";
      readonly expression: SqlExpression;
      readonly fallback: SqlExpression;
    };

export type SqlPredicate = {
  readonly type: "sql-predicate";
  readonly operator: "=" | "<>" | ">" | ">=" | "<" | "<=";
  readonly left: SqlExpression;
  readonly right: SqlExpression;
};

export type WhereObject<TRecord extends RecordShape> = {
  [K in keyof TRecord]?: WhereValue<TRecord[K]> | Record<string, unknown>;
} & {
  readonly $sql?: readonly SqlPredicate[];
} & Record<string, unknown>;

export type SqlWhereCondition<TRecord extends RecordShape> =
  | WhereObject<TRecord>
  | LogicalWhere<TRecord>
  | SqlOrCondition<TRecord>;

export type LogicalWhere<TRecord extends RecordShape> =
  | { readonly type: "logical"; readonly operator: "and"; readonly nodes: readonly WhereInput<TRecord>[] }
  | { readonly type: "logical"; readonly operator: "or"; readonly nodes: readonly WhereInput<TRecord>[] };

export type SqlOrCondition<TRecord extends RecordShape = RecordShape> = {
  readonly type: "sql-or";
  readonly conditions: readonly WhereInput<TRecord>[];
};

export type WhereInput<TRecord extends RecordShape> =
  | SqlWhereCondition<TRecord>
  | readonly SqlWhereCondition<TRecord>[];

export type FieldExpr<TRecord extends RecordShape> = {
  readonly type: "field";
  readonly field: keyof TRecord | string;
  readonly operator: Operator<unknown>;
};

export type QueryExpr<TRecord extends RecordShape> =
  | FieldExpr<TRecord>
  | SqlPredicate
  | { readonly type: "and"; readonly nodes: readonly QueryExpr<TRecord>[] }
  | { readonly type: "or"; readonly nodes: readonly QueryExpr<TRecord>[] };

/** Combines filters with AND. */
export const all = <TRecord extends RecordShape>(
  ...nodes: readonly WhereInput<TRecord>[]
): LogicalWhere<TRecord> => ({
  type: "logical",
  operator: "and",
  nodes,
});

/** Combines filters with OR. */
export const any = <TRecord extends RecordShape>(
  ...nodes: readonly WhereInput<TRecord>[]
): LogicalWhere<TRecord> => ({
  type: "logical",
  operator: "or",
  nodes,
});

/** Combines filters with OR and flattens nested sqlOr calls. */
export const sqlOr = <TRecord extends RecordShape>(
  ...conditions: readonly WhereInput<TRecord>[]
): SqlOrCondition<TRecord> => ({
  type: "sql-or",
  conditions: conditions.flatMap(condition =>
    isSqlOrCondition(condition) ? condition.conditions : [condition],
  ),
});

/** Converts a friendly where object into the internal query format. */
export function parseWhere<TRecord extends RecordShape>(input: WhereInput<TRecord>): QueryExpr<TRecord> {
  if (Array.isArray(input)) {
    return {
      type: "and",
      nodes: input.map(node => parseWhere(node)),
    };
  }

  if (isSqlOrCondition(input)) {
    return {
      type: "or",
      nodes: input.conditions.map(condition => parseWhere(condition)),
    };
  }

  if (isLogicalWhere(input)) {
    return {
      type: input.operator,
      nodes: input.nodes.map(node => parseWhere(node)),
    };
  }

  const nodes = Object.entries(input).flatMap(([field, rawValue]) => {
    if (field === "$sql") {
      return parseSqlPredicates<TRecord>(rawValue);
    }

    return parseFieldEntry<TRecord>(field, rawValue, false);
  });
  return { type: "and", nodes };
}

function parseFieldEntry<TRecord extends RecordShape>(
  field: string,
  rawValue: unknown,
  internalPath: boolean,
): FieldExpr<TRecord>[] {
  if (!internalPath && field.includes(".")) {
    throw new Error(`Use nested filters for relations: { ${field.split(".")[0]}: { ... } }`);
  }

  if (isPlainNestedWhere(rawValue)) {
    return Object.entries(rawValue).flatMap(
      ([nestedField, nestedValue]) =>
        parseFieldEntry<TRecord>(
          `${field}.${nestedField}`,
          nestedValue,
          true,
        ),
    );
  }

  return [
    {
      type: "field" as const,
      field,
      operator: resolveOperator(rawValue),
    },
  ];
}

function isPlainNestedWhere(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isOperator(value) &&
    !isSqlExpression(value) &&
    !isSqlPredicate(value) &&
    !(value instanceof Date)
  );
}

function isLogicalWhere<TRecord extends RecordShape>(input: WhereInput<TRecord>): input is LogicalWhere<TRecord> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "type" in input &&
    input.type === "logical" &&
    "operator" in input &&
    "nodes" in input
  );
}

function isSqlOrCondition<TRecord extends RecordShape>(input: WhereInput<TRecord>): input is SqlOrCondition<TRecord> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "type" in input &&
    input.type === "sql-or" &&
    "conditions" in input &&
    Array.isArray(input.conditions)
  );
}

function resolveOperator(rawValue: unknown): Operator<unknown> {
  if (isOperator(rawValue)) {
    return rawValue;
  }

  if (Array.isArray(rawValue)) {
    return {
      type: "operator",
      name: "inList",
      values: rawValue,
    };
  }

  return {
    type: "operator",
    name: "is",
    value: rawValue,
  };
}

function parseSqlPredicates<TRecord extends RecordShape>(rawValue: unknown): QueryExpr<TRecord>[] {
  if (rawValue === undefined) return [];

  if (!Array.isArray(rawValue)) {
    throw new Error("$sql must be an array of SQL predicates");
  }

  return rawValue.map(predicate => {
    if (!isSqlPredicate(predicate)) {
      throw new Error("$sql only accepts predicates created by sqlEquals/sqlGreaterThan/etc.");
    }

    return predicate;
  });
}

/** Refers to a SQL column when building computed expressions. */
export function sqlColumn(field: string): SqlExpression {
  return {
    type: "sql-expression",
    kind: "field",
    field,
  };
}

/** Builds a SUM expression for a field or expression. */
export function sqlSum(field: string | SqlExpression): SqlExpression {
  return {
    type: "sql-expression",
    kind: "aggregate",
    fn: "sum",
    expression: toSqlExpression(field),
  };
}

/** Builds a COUNT expression, optionally with a small filter. */
export function sqlCount(
  field: string | SqlExpression,
  where?: Readonly<Record<string, unknown>>,
): SqlExpression {
  return {
    type: "sql-expression",
    kind: "aggregate",
    fn: "count",
    expression: toSqlExpression(field),
    ...(where ? { where } : {}),
  };
}

/** Adds two SQL expressions or values. */
export function sqlAdd(left: string | SqlExpression, right: unknown): SqlExpression {
  return sqlBinary("+", left, right);
}

/** Subtracts one SQL expression or value from another. */
export function sqlSub(left: string | SqlExpression, right: unknown): SqlExpression {
  return sqlBinary("-", left, right);
}

/** Multiplies two SQL expressions or values. */
export function sqlMul(left: string | SqlExpression, right: unknown): SqlExpression {
  return sqlBinary("*", left, right);
}

/** Divides one SQL expression or value by another. */
export function sqlDiv(left: string | SqlExpression, right: unknown): SqlExpression {
  return sqlBinary("/", left, right);
}

/** Uses a fallback when the expression is NULL. */
export function sqlCoalesce(expression: string | SqlExpression, fallback: unknown): SqlExpression {
  return {
    type: "sql-expression",
    kind: "coalesce",
    expression: toSqlExpression(expression),
    fallback: toSqlExpression(fallback),
  };
}

/** Creates a custom SQL equality predicate for use in `$sql`. */
export function sqlEquals(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare("=", left, right);
}

/** Creates a custom SQL not-equal predicate for use in `$sql`. */
export function sqlNotEquals(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare("<>", left, right);
}

/** Creates a custom SQL greater-than predicate for use in `$sql`. */
export function sqlGreaterThan(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare(">", left, right);
}

/** Creates a custom SQL greater-or-equal predicate for use in `$sql`. */
export function sqlGreaterOrEquals(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare(">=", left, right);
}

/** Creates a custom SQL less-than predicate for use in `$sql`. */
export function sqlLessThan(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare("<", left, right);
}

/** Creates a custom SQL less-or-equal predicate for use in `$sql`. */
export function sqlLessOrEquals(left: string | SqlExpression, right: unknown): SqlPredicate {
  return sqlCompare("<=", left, right);
}

/** Checks if a value is a SQL expression object. */
export function isSqlExpression(value: unknown): value is SqlExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SqlExpression).type === "sql-expression"
  );
}

/** Checks if a value is a SQL predicate object. */
export function isSqlPredicate(value: unknown): value is SqlPredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SqlPredicate).type === "sql-predicate" &&
    isSqlExpression((value as SqlPredicate).left) &&
    isSqlExpression((value as SqlPredicate).right)
  );
}

function sqlBinary(operator: "+" | "-" | "*" | "/", left: unknown, right: unknown): SqlExpression {
  return {
    type: "sql-expression",
    kind: "binary",
    operator,
    left: toSqlExpression(left),
    right: toSqlExpression(right),
  };
}

function sqlCompare(operator: SqlPredicate["operator"], left: unknown, right: unknown): SqlPredicate {
  return {
    type: "sql-predicate",
    operator,
    left: toSqlExpression(left),
    right: toSqlExpression(right),
  };
}

function toSqlExpression(value: unknown): SqlExpression {
  if (isSqlExpression(value)) return value;

  if (typeof value === "string") {
    return sqlColumn(value);
  }

  return {
    type: "sql-expression",
    kind: "value",
    value,
  };
}
