import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('index.js se importa sin DOM y re-exporta la API del SPEC §4', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.localStorage, 'undefined');
  const core = await import('../../docs/js/core/index.js');
  const api = [
    // dates
    'toKey', 'fromKey', 'addDays', 'weekStart', 'isoWeek', 'monthKeys', 'weekdayShort', 'formatLong', 'formatShort',
    'formatHours', 'parseHHMM', 'berlinHolidays',
    // codes
    'DEFAULT_CODES', 'guessCode', 'kindOf', 'getCode', 'shiftInterval', 'normalizeDayCodes',
    // store
    'createDefaultState', 'loadState', 'saveState', 'createStore', 'setDay', 'clearDay', 'applyScan', 'upsertCode',
    'deleteCode', 'updateSettings', 'exportBackup', 'importBackup',
    // diff, hours, advice, reminders, ics
    'scanToDays', 'diffScan', 'mergeScans', 'dayMinutes', 'weekSummary', 'monthSummary', 'getAdvice',
    'upcomingReminders', 'buildICS',
    // sync, ntfy
    'testConnection', 'ensureBranch', 'pushData', 'pullBackup', 'calendarUrls', 'parseSetupLink', 'buildSetupLink',
    'randomTopic', 'syncNtfy', 'testNtfy',
    // §9 sincronización segura y cambios de la revisión
    'syncNow', 'pullOnly', 'restoreFromRemote', 'applySyncResult', 'fetchRemoteBackup', 'encryptBackup', 'decryptBackup',
    'normalizeSyncConfig', 'syncConfigPatch', 'isValidBranch', 'SyncError', 'SYNC_MESSAGES',
    'mergeStates', 'pruneTombstones', 'saveBeforeImport', 'listBeforeImport', 'undoImport', 'syncPayload', 'dataFingerprint',
    'generateSyncKey', 'isSyncKey', 'timedInterval', 'isTimedCode', 'defaultIcsFrom', 'isAppleMobile', 'safeColor',
    // un solo dispositivo publica
    'becomePublisher', 'isReadOnlyDevice',
    // identidad antes de la red, enlace comprobado y cola única
    'ensureSyncIdentity', 'applySyncConfig', 'trySetupConfig', 'createSyncQueue', 'LINK_PLACES_AT',
    // cambio de persona o de destino (OTHER_PERSON / OTHER_TARGET)
    'personSwitchState', 'syncTargetId', 'dataTargetOf',
  ];
  for (const name of api) assert.ok(name in core, `falta ${name}`);
  // Sin localStorage el store funciona en memoria
  const store = core.createStore();
  store.set((d) => { d.settings.name = 'X'; });
  assert.equal(store.get().settings.name, 'X');
  assert.equal(store.saveOk(), true); // sin almacenamiento no hay error que avisar
});
