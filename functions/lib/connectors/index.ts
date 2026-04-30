import type { ConnectorInputType } from '../../../shared/types';
import type { ConnectorExecuteFn } from './types';
import { execute as emailExecute } from './email';
import { execute as fileWatchExecute } from './fileWatch';

/**
 * Executor registry keyed by intake path (Phase B0 universal-doors model).
 * The connectors table no longer carries a per-row type — dispatch is
 * driven by `ConnectorInput.type` (set by the endpoint that received the
 * payload). The registry below maps each intake path to the parser/branch
 * that knows how to turn that payload shape into orders + customers.
 *
 * api_poll / webhook executors land with their respective Phase B slices.
 * The B2 HTTP POST drop endpoint reuses the file_watch executor (it's a
 * single-file upload by another name).
 */
const CONNECTORS: Record<string, ConnectorExecuteFn> = {
  email: emailExecute,
  file_watch: fileWatchExecute,
};

export function getConnectorExecutor(inputType: ConnectorInputType): ConnectorExecuteFn {
  const executor = CONNECTORS[inputType];
  if (!executor) {
    throw new Error(`Connector intake path '${inputType}' is not implemented yet`);
  }
  return executor;
}

export { executeConnectorRun } from './orchestrator';
export type { ConnectorOutput, ConnectorInput, ConnectorContext, ConnectorExecuteFn } from './types';
export { encryptCredentials, decryptCredentials } from './crypto';
