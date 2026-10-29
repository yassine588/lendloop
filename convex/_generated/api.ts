/* eslint-disable */
/**
 * Generated `api` and `internal` module references for Convex functions.
 */
import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi } from "convex/server";
import type * as http from "../http";
import type * as loans from "../loans";
import type * as n8n from "../n8n";
import type * as tools from "../tools";
import type * as users from "../users";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  loans: typeof loans;
  n8n: typeof n8n;
  tools: typeof tools;
  users: typeof users;
}>;

export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;
