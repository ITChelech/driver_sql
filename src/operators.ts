export type OperatorName =
  | "is"
  | "not"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "inList"
  | "isNull"
  | "notNull";

const operatorNames = new Set<OperatorName>([
  "is",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "startsWith",
  "endsWith",
  "inList",
  "isNull",
  "notNull",
]);

export type Operator<TValue> = {
  readonly type: "operator";
  readonly name: OperatorName;
  readonly value?: TValue;
  readonly values?: readonly TValue[];
};

const op = <TValue>(name: OperatorName, value?: TValue, values?: readonly TValue[]): Operator<TValue> => ({
  type: "operator",
  name,
  value,
  values,
});

/** Matches values that are equal to the given value. */
export const is = <TValue>(value: TValue) => op("is", value);
/** Matches values that are different from the given value. */
export const not = <TValue>(value: TValue) => op("not", value);
/** Matches numbers or dates greater than the given value. */
export const gt = <TValue extends number | Date>(value: TValue) => op("gt", value);
/** Matches numbers or dates greater than or equal to the given value. */
export const gte = <TValue extends number | Date>(value: TValue) => op("gte", value);
/** Matches numbers or dates less than the given value. */
export const lt = <TValue extends number | Date>(value: TValue) => op("lt", value);
/** Matches numbers or dates less than or equal to the given value. */
export const lte = <TValue extends number | Date>(value: TValue) => op("lte", value);
/** Matches numbers or dates inside a range. */
export const between = <TValue extends number | Date>(min: TValue, max: TValue) =>
  op<TValue>("between", undefined, [min, max]);
/** Matches text that contains the given value. */
export const contains = (value: string) => op("contains", value);
/** Matches text that starts with the given value. */
export const startsWith = (value: string) => op("startsWith", value);
/** Matches text that ends with the given value. */
export const endsWith = (value: string) => op("endsWith", value);
/** Matches any value in the given list. */
export const inList = <TValue>(values: readonly TValue[]) => op<TValue>("inList", undefined, values);
/** Matches SQL NULL values. */
export const isNull = () => op<null>("isNull");
/** Matches values that are not SQL NULL. */
export const notNull = () => op<null>("notNull");

/** Checks if a string is one of the supported operator names. */
export const isOperatorName = (value: unknown): value is OperatorName =>
  typeof value === "string" && operatorNames.has(value as OperatorName);

/** Checks if a value was created by one of the operator helpers. */
export const isOperator = (value: unknown): value is Operator<unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as Operator<unknown>).type === "operator" &&
  isOperatorName((value as Operator<unknown>).name);
