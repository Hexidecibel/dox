import { queryResolvers } from './queries';
import { mutationResolvers } from './mutations';
import { typeResolvers } from './types';

export const resolvers = {
  Query: queryResolvers,
  Mutation: mutationResolvers,
  ...typeResolvers,
};
