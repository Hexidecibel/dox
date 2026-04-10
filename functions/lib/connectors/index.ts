import type { ConnectorType } from '../../../shared/types';
import type { ConnectorExecuteFn } from './types';
import { execute as emailExecute } from './email';

const CONNECTORS: Record<string, ConnectorExecuteFn> = {
  email: emailExecute,
  // api_poll, webhook, file_watch added in Phase 3
};

export function getConnectorExecutor(type: ConnectorType): ConnectorExecuteFn {
  const executor = CONNECTORS[type];
  if (!executor) {
    throw new Error(`Connector type '${type}' is not implemented yet`);
  }
  return executor;
}

export { executeConnectorRun } from './orchestrator';
export type { ConnectorOutput, ConnectorInput, ConnectorContext, ConnectorExecuteFn } from './types';
export { encryptCredentials, decryptCredentials } from './crypto';
