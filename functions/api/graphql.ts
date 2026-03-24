import { createYoga, createSchema } from 'graphql-yoga';
import { typeDefs } from '../lib/graphql/schema';
import { resolvers } from '../lib/graphql/resolvers';
import { buildContext, type GraphQLContext } from '../lib/graphql/context';
import type { Env } from '../lib/types';

/**
 * Build a graphql-yoga instance.
 * graphql-yoga uses the standard Fetch API (Request/Response) which is
 * natively supported in Cloudflare Workers / Pages Functions.
 */
function createYogaHandler() {
  return createYoga<GraphQLContext>({
    schema: createSchema({
      typeDefs,
      resolvers,
    }),
    // Let Pages Functions handle the routing — yoga just serves /api/graphql
    graphqlEndpoint: '/api/graphql',
    // Enable GraphiQL in all environments for now (can restrict later)
    graphiql: true,
    // Disable landing page (we use GraphiQL)
    landingPage: false,
  });
}

// Cache the yoga instance across requests (module-level singleton)
let yoga: ReturnType<typeof createYogaHandler> | null = null;

function getYoga() {
  if (!yoga) {
    yoga = createYogaHandler();
  }
  return yoga;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const yogaInstance = getYoga();
  const ctx = await buildContext(context.request, context.env);

  return yogaInstance.handleRequest(context.request, ctx);
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const yogaInstance = getYoga();
  const ctx = await buildContext(context.request, context.env);

  return yogaInstance.handleRequest(context.request, ctx);
};
