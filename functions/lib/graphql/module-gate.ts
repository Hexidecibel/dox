/**
 * The module gate for GraphQL — the one surface the REST middleware cannot
 * reach.
 *
 * WHY THIS FILE EXISTS. `/api/graphql` is in `PUBLIC_ROUTES` and authenticates
 * itself in `./context.ts`, so it never passes through the `moduleGate`
 * handler in `functions/api/_middleware.ts`. That is not a bug in the
 * middleware — a single POST can address any number of fields, so there is no
 * URL for a path-based gate to read. The gate therefore has to live where the
 * fields are. Without it, module visibility would be a switch that hides a
 * surface while its data stays queryable by anyone who knows the schema, and a
 * switch like that is worse than no switch: it invites somebody to rely on it.
 *
 * ONE IMPLEMENTATION, TWO ENTRY POINTS. Nothing about "who may see what" is
 * decided here. The rules live in `shared/modules.ts` (pure), the reads in
 * `functions/lib/module-access.ts`, and the WORDING of a refusal in that
 * file's `denialForModule`, which the REST middleware calls too. This file
 * only turns that shared answer into a `GraphQLError`. The middleware's own
 * failure mode was three layers disagreeing about who can see what; a GraphQL
 * gate that re-derived any of it would be a fourth.
 *
 * DECLARED PER FIELD, EXHAUSTIVELY, AND CHECKED BY THE COMPILER. Each resolver
 * map ships a sibling `Record<keyof typeof resolvers, ModuleKey | null>`, so
 * adding a resolver without saying which module owns it does not compile. That
 * is the point: the dangerous state is not a wrong answer, it is a new
 * resolver nobody thought about, silently defaulting to open. An explicit
 * `null` is a decision on the record — and most fields genuinely are `null`,
 * because a module owns a resolver only when its data EXCLUSIVELY serves that
 * module's surfaces. `/api/documents` is the standing precedent (see the
 * `apiPrefixes` comment in `shared/modules.ts`): renewal digests, alert
 * landings and COA fulfillment all read documents, so gating documents behind
 * `library` would break `compliance` and `fulfillment` for a tenant that has
 * them switched ON. Shared read primitives stay ungated and are gated, as they
 * always were, by tenant isolation and the four permission tiers.
 *
 * SCOPE, NOT SECURITY — so it FAILS OPEN. `loadModuleAccess` already swallows
 * its own D1 failures and answers "everything, degraded", which means a
 * database blip lands here as an allow and is logged there. Nothing in this
 * file may tighten that: tenant isolation (`requireTenantAccess`) and the four
 * permission tiers (`requireRole`) are the security boundary and are untouched
 * by any of this.
 */

import { GraphQLError } from 'graphql';
import { denialForModule } from '../module-access';
import type { ModuleKey } from '../../../shared/modules';
import type { GraphQLContext } from './context';

/**
 * Refuse this field unless the caller may see `moduleKey`.
 *
 * NO USER MEANS NO GATE, exactly as in the middleware. An anonymous caller has
 * a null `moduleAccess` — there is no answer to "which modules are yours" for
 * nobody — and is passed straight through to the resolver's own `requireAuth`,
 * so an unauthenticated request to a gated field still reports that it needs
 * authentication rather than that a module is off. super_admin needs no
 * special case here: `loadModuleAccess` hands them every module by
 * construction, which is where that bypass belongs.
 */
export function requireModule(ctx: GraphQLContext, moduleKey: ModuleKey): void {
  if (!ctx.user || !ctx.moduleAccess) return;

  const denial = denialForModule(ctx.moduleAccess, moduleKey);
  if (!denial) return;

  // A `GraphQLError` and not a plain `Error`: graphql-yoga masks anything that
  // is not one down to "Unexpected error.", which would take the code and the
  // module name with it. The extensions carry the SAME `module_disabled` /
  // `module_not_visible` vocabulary the REST gate puts in its 403 body, so a
  // client can tell "the tenant disabled it" from "your function does not
  // include it" over either transport.
  throw new GraphQLError(denial.message, {
    extensions: { code: denial.code, module: denial.module },
  });
}

/**
 * A resolver as this file needs to see one. `never` in the parameter
 * positions is what makes every concrete resolver — `(parent: unknown, args:
 * { id: string }, ...)` and friends — assignable to it under
 * `strictFunctionTypes`, which checks parameters contravariantly.
 */
type GatedResolver = (parent: never, args: never, ctx: GraphQLContext, info: never) => unknown;

/** The same function, as it is actually invoked. */
type InvokedResolver = (parent: unknown, args: unknown, ctx: GraphQLContext, info: unknown) => unknown;

/**
 * Wrap a resolver map with its module declarations.
 *
 * Applied once, in `./resolvers/index.ts`, rather than per resolver: a check
 * copy-pasted into two dozen function bodies is a check that will be missing
 * from the twenty-fifth. The wrapper runs BEFORE the resolver body, so a
 * refused field costs nothing beyond the lookup the context already did, and
 * a `null` declaration returns the original function untouched — an ungated
 * resolver is not wrapped at all.
 */
export function gateResolvers<T extends Record<string, GatedResolver>>(
  resolvers: T,
  modules: Record<keyof T, ModuleKey | null>,
): T {
  const gated: Record<string, GatedResolver> = {};

  for (const [field, resolver] of Object.entries(resolvers)) {
    const moduleKey = modules[field as keyof T];
    if (moduleKey === null) {
      gated[field] = resolver;
      continue;
    }

    const invoke = resolver as unknown as InvokedResolver;
    const wrapped: InvokedResolver = (parent, args, ctx, info) => {
      requireModule(ctx, moduleKey);
      return invoke(parent, args, ctx, info);
    };
    gated[field] = wrapped as unknown as GatedResolver;
  }

  return gated as T;
}
