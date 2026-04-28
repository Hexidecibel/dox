import packageJson from '../../package.json';

export const versionInfo = {
  version: packageJson.version,
  sha: __BUILD_SHA__,
  label: `v${packageJson.version} · ${__BUILD_SHA__}`,
};
