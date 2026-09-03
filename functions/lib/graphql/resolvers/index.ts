import { queryResolvers, queryModules } from './queries';
import { mutationResolvers, mutationModules } from './mutations';
import { typeResolvers } from './types';
import { gateResolvers } from '../module-gate';

/**
 * THE MODULE GATE IS APPLIED HERE, once, on the way into the schema —
 * `/api/graphql` authenticates itself and never reaches the REST middleware's
 * gate, so this is the only place it can be applied. See
 * `../module-gate.ts` for why the declarations are exhaustive and why most of
 * them are `null`.
 *
 * `typeResolvers` is NOT gated, and does not need to be. Nested fields hang
 * off a root that has already been through the gate, and every one of them
 * resolves the shared primitives — documents, users, tenants, versions — which
 * belong to no module by the same reasoning that keeps `/api/documents` out of
 * `library.apiPrefixes`. If a nested field ever reaches a module's own data,
 * it gets its own declaration map here rather than an inline check.
 */
export const resolvers = {
  Query: gateResolvers(queryResolvers, queryModules),
  Mutation: gateResolvers(mutationResolvers, mutationModules),
  ...typeResolvers,
};
