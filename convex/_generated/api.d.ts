/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiKeys from "../apiKeys.js";
import type * as artifacts from "../artifacts.js";
import type * as automations from "../automations.js";
import type * as crons from "../crons.js";
import type * as executor from "../executor.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_manifest from "../lib/manifest.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_waitForResult from "../lib/waitForResult.js";
import type * as notifications from "../notifications.js";
import type * as runs from "../runs.js";
import type * as secrets from "../secrets.js";
import type * as testRuns from "../testRuns.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apiKeys: typeof apiKeys;
  artifacts: typeof artifacts;
  automations: typeof automations;
  crons: typeof crons;
  executor: typeof executor;
  files: typeof files;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/crypto": typeof lib_crypto;
  "lib/manifest": typeof lib_manifest;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/waitForResult": typeof lib_waitForResult;
  notifications: typeof notifications;
  runs: typeof runs;
  secrets: typeof secrets;
  testRuns: typeof testRuns;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
