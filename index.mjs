import { fileURLToPath } from 'node:url';
import { startCatalogSync } from './catalog-sync.mjs';
import { startNativeAssets } from './native-assets.mjs';
import { startSettingsSync } from './settings-sync.mjs';
import { initializeRequestIndex } from './request-index.mjs';
import { startDiagnosticsLedger } from './diagnostics-ledger.mjs';

export default async function KupaDeskNativePage(input, options = {}) {
  const packageDir = fileURLToPath(new URL('.', import.meta.url));
  function log(code) {
    // Fixed categories only: never log configuration, URLs, responses or
    // raw errors from a host that may hold provider credentials.
    try {
      void input?.client?.app?.log?.({ body: { service: 'kupadesk-native',
        level: 'warn', message: code } })?.catch?.(() => {});
    } catch { /* Optional diagnostics must not block providers. */ }
  }
  try {
    if (input?.directory) await initializeRequestIndex(input.directory, packageDir);
  } catch { log('request_index_initialization_failed'); }
  try {
    await startNativeAssets({ packageDir, log });
  } catch {
    // A native page asset failure must not interfere with original providers.
    log('native_assets_start_failed');
  }
  try {
    startCatalogSync({ directory: input?.directory,
      packageDir, options, log,
    });
  } catch {
    // Catalog discovery must not interfere with requests or plugin startup.
  }
  startSettingsSync({directory:input?.directory,log});
  try { startDiagnosticsLedger({directory:input?.directory}); }
  catch { log('diagnostics_unavailable'); }
  return {};
}
