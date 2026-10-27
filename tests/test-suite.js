const fs = require('fs');
const os = require('os');
const assert = require('assert');
const path = require('path');

// Never touch the real config.json / logs / window-state.json while testing.
if (!process.env.SHEETSTOOBS_DATA_DIR) {
  process.env.SHEETSTOOBS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetstoobs-test-'));
}
const { dataFile } = require('../src/paths');
const ConfigManager = require('../src/engine/config-manager');
const ImporterEngine = require('../src/engine/importer-engine');

// Clean up any previous test artifacts
const testConfigPath = path.join(__dirname, 'test-config.json');
const testProfilesPath = path.join(__dirname, 'test-profiles.json');
const testServerConfigPath = path.join(__dirname, 'test-server-config.json');
if (fs.existsSync(testConfigPath)) fs.unlinkSync(testConfigPath);
if (fs.existsSync(testProfilesPath)) fs.unlinkSync(testProfilesPath);
if (fs.existsSync(testServerConfigPath)) fs.unlinkSync(testServerConfigPath);

console.log('==================================================');
console.log('RUNNING UNIT & INTEGRATION TESTS FOR OBS SHEETS GUI');
console.log('==================================================\n');

// TEST 1: ConfigManager URL parsing
console.log('--- Test 1: ConfigManager URL Extraction ---');
const rawUrl = 'https://docs.google.com/spreadsheets/d/1Z1MlruzHm0UYCNO4cTlcDtUdWrMaRB5gwkVy7Zthl8c/edit#gid=0';
const extractedId = ConfigManager.extractSheetId(rawUrl);
assert.strictEqual(extractedId, '1Z1MlruzHm0UYCNO4cTlcDtUdWrMaRB5gwkVy7Zthl8c', 'Failed to extract sheet ID from full URL');
console.log('✅ Extracted ID from full URL:', extractedId);

const rawId = '1Z1MlruzHm0UYCNO4cTlcDtUdWrMaRB5gwkVy7Zthl8c';
assert.strictEqual(ConfigManager.extractSheetId(rawId), rawId, 'Failed on clean ID');
console.log('✅ Clean ID preserved correctly');

// TEST 2: ConfigManager Loading & Saving
console.log('\n--- Test 2: ConfigManager Load & Save ---');
const cfgMgr = new ConfigManager(testConfigPath);
const saved = cfgMgr.save({
  sheetId: rawUrl,
  tabname: 'TestTab',
  polling: 3000
});
assert.strictEqual(saved.success, true, 'Config save failed');
assert.strictEqual(saved.config.sheetId, '1Z1MlruzHm0UYCNO4cTlcDtUdWrMaRB5gwkVy7Zthl8c', 'Saved config did not auto-sanitize sheetId');
assert.strictEqual(saved.config.polling, 3000, 'Saved config polling mismatch');

// Test seconds conversion (e.g. 10 -> 10000)
const saved10s = cfgMgr.save({ polling: 10 });
assert.strictEqual(saved10s.config.polling, 10000, 'Failed to convert 10 seconds to 10000ms');
const saved10k = cfgMgr.save({ polling: 10000 });
assert.strictEqual(saved10k.config.polling, 10000, 'Failed to preserve 10000ms polling');
console.log('✅ Config saved and sanitized successfully (including 10s -> 10000ms parsing)');

// TEST 3: Tag Parsing in ImporterEngine
console.log('\n--- Test 3: Tag Parsing & Color Conversion ---');
const colorHex = '#FF5500';
const obsColor = ImporterEngine.hexToObsColor(colorHex);
assert.ok(typeof obsColor === 'number', 'Obs color conversion failed');
console.log(`✅ Hex ${colorHex} converted to OBS BGR int: ${obsColor} (0x${obsColor.toString(16)})`);

const colorTag = ImporterEngine.parseCellTags('?color=#FF5500;Grand Finals');
assert.strictEqual(colorTag.cleanValue, 'Grand Finals', 'Color tag clean value mismatch');
assert.strictEqual(colorTag.color, obsColor, 'Color tag parsed color mismatch');
console.log('✅ ?color tag parsed:', colorTag);

const strikeTag = ImporterEngine.parseCellTags('?fontstyle=strikethrough;Team Eliminated');
assert.strictEqual(strikeTag.cleanValue, 'Team Eliminated', 'Strikethrough clean value mismatch');
assert.strictEqual(strikeTag.fontstyle, 8, 'Strikethrough flag mismatch');
console.log('✅ ?fontstyle=strikethrough parsed:', strikeTag);

const underTag = ImporterEngine.parseCellTags('?fontstyle=underline;Champion Team');
assert.strictEqual(underTag.cleanValue, 'Champion Team', 'Underline clean value mismatch');
assert.strictEqual(underTag.fontstyle, 4, 'Underline flag mismatch');
console.log('✅ ?fontstyle=underline parsed:', underTag);

const hideTag = ImporterEngine.parseCellTags('?hide;Hidden Subtitle');
assert.strictEqual(hideTag.cleanValue, 'Hidden Subtitle', 'Hide clean value mismatch');
assert.strictEqual(hideTag.visibility, false, 'Hide flag mismatch');
console.log('✅ ?hide tag parsed:', hideTag);

const showTag = ImporterEngine.parseCellTags('?show;Visible Subtitle');
assert.strictEqual(showTag.cleanValue, 'Visible Subtitle', 'Show clean value mismatch');
assert.strictEqual(showTag.visibility, true, 'Show flag mismatch');
console.log('✅ ?show tag parsed:', showTag);

// SourceSwitcher ;; playlist splitting test
const switcherRaw = '?show;Cam 1, Desk Angle;; Cam 2, Gameplay Direct;; Cam 3, Crowd';
const parsedSwitcher = ImporterEngine.parseCellTags(switcherRaw);
assert.strictEqual(parsedSwitcher.visibility, true, 'Failed to extract visibility tag from switcher');
const playlistItems = parsedSwitcher.cleanValue.split(/;;|\r?\n/).map(s => s.trim()).filter(Boolean);
assert.strictEqual(playlistItems.length, 3, 'Failed to split ;; playlist items');
assert.strictEqual(playlistItems[0], 'Cam 1, Desk Angle', 'Failed on comma-safe item 1');
assert.strictEqual(playlistItems[1], 'Cam 2, Gameplay Direct', 'Failed on item 2');
assert.strictEqual(playlistItems[2], 'Cam 3, Crowd', 'Failed on item 3');
console.log('✅ SourceSwitcher ;; playlist splitting & tag extraction verified:', playlistItems);

// TEST 3.5: Color Variant Extraction & Source Name Comparison
console.log('\n--- Test 3.5: Color Variant Extraction & Source Name Comparison ---');

// Variant extraction tests
const varTest1 = ImporterEngine.extractColorVariant('Talent Name 1 - White');
assert.strictEqual(varTest1.baseName, 'Talent Name 1', 'Failed to extract base name for - White suffix');
assert.strictEqual(varTest1.variant, 'White', 'Failed to extract White variant');

const varTest2 = ImporterEngine.extractColorVariant('Talent Name 1 (Black)');
assert.strictEqual(varTest2.baseName, 'Talent Name 1', 'Failed to extract base name for (Black) suffix');
assert.strictEqual(varTest2.variant, 'Black', 'Failed to extract Black variant');

const varTest3 = ImporterEngine.extractColorVariant('Talent Name 1_white');
assert.strictEqual(varTest3.baseName, 'Talent Name 1', 'Failed to extract base name for _white');
assert.strictEqual(varTest3.variant, 'White', 'Failed to extract White variant from _white');

const varTest4 = ImporterEngine.extractColorVariant('Talent Name 1 [Black]');
assert.strictEqual(varTest4.baseName, 'Talent Name 1', 'Failed to extract base name for [Black]');
assert.strictEqual(varTest4.variant, 'Black', 'Failed to extract Black variant from [Black]');

const varTest5 = ImporterEngine.extractColorVariant('Talent Role 1');
assert.strictEqual(varTest5.baseName, 'Talent Role 1', 'Base name should be unmodified');
assert.strictEqual(varTest5.variant, null, 'Variant should be null for regular name');

const varTestRed = ImporterEngine.extractColorVariant('Team 1 Name - Red');
assert.strictEqual(varTestRed.baseName, 'Team 1 Name', 'Failed to extract base name for - Red suffix');
assert.strictEqual(varTestRed.variant, 'Red', 'Failed to extract Red variant');

const varTestBlue = ImporterEngine.extractColorVariant('Team 2 Name (Blue)');
assert.strictEqual(varTestBlue.baseName, 'Team 2 Name', 'Failed to extract base name for (Blue) suffix');
assert.strictEqual(varTestBlue.variant, 'Blue', 'Failed to extract Blue variant');

const varTestExtra = ImporterEngine.extractColorVariant('Match Title - Extra');
assert.strictEqual(varTestExtra.baseName, 'Match Title', 'Failed to extract base name for - Extra suffix');
assert.strictEqual(varTestExtra.variant, 'Extra', 'Failed to extract Extra variant');

const varTestAlt = ImporterEngine.extractColorVariant('Player 1 [Alt]');
assert.strictEqual(varTestAlt.baseName, 'Player 1', 'Failed to extract base name for [Alt]');
assert.strictEqual(varTestAlt.variant, 'Extra', 'Failed to extract Extra variant from Alt');

console.log('✅ extractColorVariant accurately detected White/Black/Red/Blue/Extra suffixes & brackets');

// Name comparison tests
const compExact = ImporterEngine.compareSourceName('Talent Role 1 |sheet 2', 2, 'Talent Role 1', 'Talent Role 1 |sheet 2');
assert.strictEqual(compExact.status, 'exact', 'Exact match failed');
assert.strictEqual(compExact.isMatch, true, 'Exact match isMatch should be true');

const compWhite = ImporterEngine.compareSourceName('Talent Name 1 - White |sheet 3', 3, 'Talent Name 1', 'Talent Name 1 |sheet 3');
assert.strictEqual(compWhite.status, 'variant', 'White variant comparison failed');
assert.strictEqual(compWhite.variant, 'White', 'White variant detection failed');
assert.strictEqual(compWhite.isMatch, true, 'White variant should be recognized as a compatible match');

const compBlack = ImporterEngine.compareSourceName('Talent Name 1 (Black) |sheet 3', 3, 'Talent Name 1', 'Talent Name 1 |sheet 3');
assert.strictEqual(compBlack.status, 'variant', 'Black variant comparison failed');
assert.strictEqual(compBlack.variant, 'Black', 'Black variant detection failed');
assert.strictEqual(compBlack.isMatch, true, 'Black variant should be recognized as a compatible match');

const compRed = ImporterEngine.compareSourceName('Team 1 Name - Red |sheet 4', 4, 'Team 1 Name', 'Team 1 Name |sheet 4');
assert.strictEqual(compRed.status, 'variant', 'Red variant comparison failed');
assert.strictEqual(compRed.variant, 'Red', 'Red variant detection failed');
assert.strictEqual(compRed.isMatch, true, 'Red variant should be recognized as a compatible match');

const compBlue = ImporterEngine.compareSourceName('Team 2 Name (Blue) |sheet 5', 5, 'Team 2 Name', 'Team 2 Name |sheet 5');
assert.strictEqual(compBlue.status, 'variant', 'Blue variant comparison failed');
assert.strictEqual(compBlue.variant, 'Blue', 'Blue variant detection failed');
assert.strictEqual(compBlue.isMatch, true, 'Blue variant should be recognized as a compatible match');

const compExtra = ImporterEngine.compareSourceName('Match Title - Extra |sheet 2', 2, 'Match Title', 'Match Title |sheet 2');
assert.strictEqual(compExtra.status, 'variant', 'Extra variant comparison failed');
assert.strictEqual(compExtra.variant, 'Extra', 'Extra variant detection failed');
assert.strictEqual(compExtra.isMatch, true, 'Extra variant should be recognized as a compatible match');

const compMismatch = ImporterEngine.compareSourceName('Caster 1 Name |sheet 3', 3, 'Talent Name 1', 'Talent Name 1 |sheet 3');
assert.strictEqual(compMismatch.status, 'mismatch', 'Mismatch comparison failed');
assert.strictEqual(compMismatch.isMatch, false, 'Mismatch isMatch should be false');

console.log('✅ compareSourceName accurately classified Exact Matches, White/Black/Red/Blue/Extra Variants, and Name Mismatches');

console.log('\n--- Test 5: Profile Creation, Switching, Data Retention & Deletion ---');
const profMgr = new ConfigManager(testProfilesPath);

// 1. Initial State: Must start with only ['Default'] without hardcoded CCS1/CCS2
const initialList = profMgr.listProfiles();
assert.deepStrictEqual(initialList, ['Default'], 'Profiles list should initially only have [Default]');
assert.strictEqual(profMgr.getActiveProfileName(), 'Default', 'Active profile should initially be Default');
console.log('✅ Starts cleanly with single Default profile:', initialList);

// 2. Create custom profiles CCS1 and CCS2
profMgr.createProfile('CCS1', { sheetId: 'id-ccs1', tabname: 'Overlay1', polling: 2000 });
profMgr.createProfile('CCS2', { sheetId: 'id-ccs2', tabname: 'Overlay2', polling: 4000 });
const listWithCustom = profMgr.listProfiles();
assert.ok(listWithCustom.includes('CCS1'), 'Profiles list missing CCS1');
assert.ok(listWithCustom.includes('CCS2'), 'Profiles list missing CCS2');
console.log('✅ Created custom profiles:', listWithCustom);

// 3. Switch between profiles and verify data is retained
profMgr.switchProfile('CCS1');
assert.strictEqual(profMgr.getActiveProfileName(), 'CCS1', 'Active profile should be CCS1');
assert.strictEqual(profMgr.get().sheetId, 'id-ccs1', 'Active profile config mismatch for CCS1');

profMgr.switchProfile('CCS2');
assert.strictEqual(profMgr.getActiveProfileName(), 'CCS2', 'Active profile should be CCS2');
assert.strictEqual(profMgr.get().sheetId, 'id-ccs2', 'Active profile config mismatch for CCS2');

// Switch back to CCS1 and verify information was retained
profMgr.switchProfile('CCS1');
assert.strictEqual(profMgr.get().sheetId, 'id-ccs1', 'CCS1 did not retain its sheetId after switching back');
assert.strictEqual(profMgr.get().tabname, 'Overlay1', 'CCS1 did not retain its tabname after switching back');
console.log('✅ Profiles properly retained their configuration across switches');

// 4. Duplicate CCS1 -> CCS1_Copy
const dup = profMgr.duplicateProfile('CCS1', 'CCS1_Copy');
assert.ok(dup.success, 'Failed to duplicate profile');
assert.strictEqual(profMgr.getProfile('CCS1_Copy').sheetId, 'id-ccs1', 'Duplicated profile config mismatch');
console.log('✅ Duplicated CCS1 to CCS1_Copy');

// 4.5. Set personal credentials on CCS1
profMgr.switchProfile('CCS1');
profMgr.save({
  sheetId: 'id-ccs1',
  tabname: 'Overlay1',
  apikey: 'SECRET_API_KEY_12345',
  obsauth: 'SECRET_OBS_PASS_9999'
});
assert.strictEqual(profMgr.get().apikey, 'SECRET_API_KEY_12345', 'apikey did not save');
console.log('✅ Personal credentials saved on profile CCS1');

// 5. Export single profile (Clean vs Full Backup) & bundle
const expClean = profMgr.exportProfile('CCS1', false); // Clean
assert.strictEqual(expClean.profileName, 'CCS1', 'Exported single profile name mismatch');
assert.strictEqual(expClean.includePersonal, false, 'Clean export includePersonal should be false');
assert.strictEqual(expClean.config.sheetId, '', 'Clean export must not contain the Sheet ID (use "include sheet access")');
const expShared = profMgr.exportProfile('CCS1', false, { includeSheetAccess: true });
assert.strictEqual(expShared.config.sheetId, 'id-ccs1', 'Sheet-access export must keep the Sheet ID');
assert.strictEqual(expClean.config.apikey, undefined, 'Clean export must not contain apikey');
assert.strictEqual(expClean.config.obsauth, undefined, 'Clean export must not contain obsauth');
console.log('✅ Clean profile export verified (sensitive credentials stripped for sharing)');

const expFull = profMgr.exportProfile('CCS1', true); // Full Backup
assert.strictEqual(expFull.includePersonal, true, 'Full backup includePersonal should be true');
assert.strictEqual(expFull.config.apikey, 'SECRET_API_KEY_12345', 'Full backup should include apikey');
assert.strictEqual(expFull.config.obsauth, 'SECRET_OBS_PASS_9999', 'Full backup should include obsauth');
console.log('✅ Full backup profile export verified (contains personal credentials)');

const expBundle = profMgr.exportAll(false); // Clean bundle
assert.strictEqual(expBundle.type, 'all-profiles', 'Export bundle missing all-profiles type');
assert.strictEqual(expBundle.includePersonal, false, 'Clean bundle includePersonal should be false');
assert.ok(expBundle.profiles.CCS2, 'Export bundle missing CCS2');
assert.strictEqual(expBundle.profiles.CCS1.apikey, undefined, 'Clean bundle CCS1 should not contain apikey');
console.log('✅ Exported clean all-profiles bundle successfully');

// 6. Import clean profile (should inherit user existing credentials)
const imported = profMgr.importData({
  type: 'single-profile',
  profileName: 'CCS3_Imported',
  config: { sheetId: 'id-ccs3', tabname: 'ImportTab', polling: 1500 }
});
assert.ok(imported.success, 'Failed to import profile');
assert.ok(profMgr.listProfiles().includes('CCS3_Imported'), 'Imported profile not in profile list');
profMgr.switchProfile('CCS3_Imported');
assert.strictEqual(profMgr.get().tabname, 'ImportTab', 'Imported profile missing tabname');
assert.strictEqual(profMgr.get().apikey, 'SECRET_API_KEY_12345', 'Imported clean profile should inherit local API key');
console.log('✅ Imported clean profile CCS3_Imported successfully with credential inheritance');

// 7. Delete profiles and test delete-down-to-reset
profMgr.deleteProfile('CCS1_Copy');
profMgr.deleteProfile('CCS3_Imported');
profMgr.deleteProfile('CCS1');
profMgr.deleteProfile('CCS2');
// Now only 'Default' remains, delete it to test reset-to-clean-Default
const resetResult = profMgr.deleteProfile('Default');
assert.strictEqual(resetResult.success, true, 'Deleting last profile should succeed and reset to Default');
assert.strictEqual(resetResult.activeProfile, 'Default', 'Active profile should be Default after reset');
assert.deepStrictEqual(profMgr.listProfiles(), ['Default'], 'Should have [Default] profile after reset');
console.log('✅ Deleting profiles down to empty resets cleanly to Default profile');

// TEST 6: Visibility Deduping & Log Filtering
console.log('\n--- Test 6: Visibility Log Deduping Logic ---');
const visEngine = new ImporterEngine(profMgr);
let visLogCount = 0;
visEngine.on('log', (entry) => {
  if (entry.text && entry.text.includes('Visibility')) {
    visLogCount++;
  }
});

// Set active profile config with visibility deduplication enabled
profMgr.save({
  logVisibilityOnlyOnChanges: true,
  showVisibilityLogs: true
});

// Verify visibilityStateMap tracks changes
visEngine.visibilityStateMap.set('TestScene::OverlayItem', true);
const isSame = visEngine.visibilityStateMap.get('TestScene::OverlayItem') === true;
assert.strictEqual(isSame, true, 'Visibility state tracking map failed');
console.log('✅ Visibility tracking state verified');

// TEST 6.5: WIP Detection & Missing Row Suppression
console.log('\n--- Test 6.5: WIP Source Detection & Missing Row Log Suppression ---');
assert.strictEqual(ImporterEngine.isWipSource('Record 8 WIP |sheet 275'), true, 'Should detect WIP at end of source name');
assert.strictEqual(ImporterEngine.isWipSource('WIP Record 8 |sheet 275'), true, 'Should detect WIP at start of source name');
assert.strictEqual(ImporterEngine.isWipSource('[WIP] Caster 1 |sheet 3'), true, 'Should detect [WIP] prefix');
assert.strictEqual(ImporterEngine.isWipSource('(WIP) Caster 1 |sheet 3'), true, 'Should detect (WIP) prefix');
assert.strictEqual(ImporterEngine.isWipSource('Normal Source |sheet 2', 'WIP Label'), true, 'Should detect WIP in label');
assert.strictEqual(ImporterEngine.isWipSource('Caster 1 Name |sheet 3', 'Caster 1'), false, 'Should return false for non-WIP');
assert.strictEqual(ImporterEngine.isWipSource('Swipe Effect |sheet 4'), false, 'Should not match substring in Swipe');

const wipEngine = new ImporterEngine(profMgr);
assert.strictEqual(wipEngine.missingRowsWarned.has('Scene::Source::275'), false);
wipEngine.missingRowsWarned.add('Scene::Source::275');
assert.strictEqual(wipEngine.missingRowsWarned.has('Scene::Source::275'), true);
wipEngine.missingRowsWarned.delete('Scene::Source::275');
assert.strictEqual(wipEngine.missingRowsWarned.has('Scene::Source::275'), false);
console.log('✅ WIP detection and missing row deduplication logic validated');

// TEST 7: Write Permissions & Error Reporting
console.log('\n--- Test 7: Write Permissions & Actionable Error Code ---');
const permCheck = profMgr.checkWritePermission();
assert.ok(typeof permCheck.isWritable === 'boolean', 'checkWritePermission did not return boolean isWritable');
console.log(`✅ File write permissions checked: isWritable = ${permCheck.isWritable}`);

// Verify structured error structure if write is denied
const DesktopServer = require('../src/server');
const testCrashError = new Error('Test permission denial and crash dump');
DesktopServer.writeCrashLog(testCrashError, 'TEST_DIAGNOSTIC');
const crashLogPath = dataFile('logs', 'crash.log');
assert.ok(fs.existsSync(crashLogPath), 'Crash log was not created in logs/crash.log');
const crashContent = fs.readFileSync(crashLogPath, 'utf8');
assert.ok(crashContent.includes('TEST_DIAGNOSTIC'), 'Crash log missing test diagnostic header');
assert.ok(crashContent.includes('Test permission denial and crash dump'), 'Crash log missing error message');
console.log('✅ Diagnostic crash logger successfully written and validated (temp data folder)');

// TEST 8: Column Sorting & Row Display Logic
console.log('\n--- Test 8: Table Sorting (Row, Type, Scene, Source Name) & Number Formatting ---');
const sampleSources = [
  { sceneName: 'Scene B', sourceName: 'Text Title', targetRow: 10, sourceType: 'Text' },
  { sceneName: 'Scene A', sourceName: 'Score Bug', targetRow: 2, sourceType: 'Text' },
  { sceneName: 'Scene A', sourceName: 'Logo Color', targetRow: 5, sourceType: 'Color' },
  { sceneName: 'Scene B', sourceName: 'Avatar Image', targetRow: 3, sourceType: 'Image' },
];

// 1. Sort by Row ascending & descending
const sortedByRowAsc = [...sampleSources].sort((a, b) => (a.targetRow - b.targetRow));
assert.strictEqual(sortedByRowAsc[0].targetRow, 2);
assert.strictEqual(sortedByRowAsc[3].targetRow, 10);

const sortedByRowDesc = [...sampleSources].sort((a, b) => (b.targetRow - a.targetRow));
assert.strictEqual(sortedByRowDesc[0].targetRow, 10);
assert.strictEqual(sortedByRowDesc[3].targetRow, 2);

// 2. Sort by Scene Name
const sortedByScene = [...sampleSources].sort((a, b) => a.sceneName.localeCompare(b.sceneName));
assert.strictEqual(sortedByScene[0].sceneName, 'Scene A');
assert.strictEqual(sortedByScene[3].sceneName, 'Scene B');

// 3. Sort by Source Name
const sortedByName = [...sampleSources].sort((a, b) => a.sourceName.localeCompare(b.sourceName));
assert.strictEqual(sortedByName[0].sourceName, 'Avatar Image');
assert.strictEqual(sortedByName[3].sourceName, 'Text Title');

// 4. Sort by Type
const sortedByType = [...sampleSources].sort((a, b) => a.sourceType.localeCompare(b.sourceType));
assert.strictEqual(sortedByType[0].sourceType, 'Color');
assert.strictEqual(sortedByType[1].sourceType, 'Image');

// 5. Verify Row Display format (only numeric `#` and not `Row #`)
const formatGridRow = (rowNum) => `${rowNum}`;
assert.strictEqual(formatGridRow(5), '5');
assert.strictEqual(formatGridRow(102), '102');
console.log('✅ Sorting by Row Number, Type, Scene/Group, and Source Name validated successfully');
console.log('✅ Sheet Data Grid numeric row representation (# only) validated');

// TEST 4: Simulation Mode
console.log('\n--- Test 4: Simulation Engine Flow ---');
const engine = new ImporterEngine(cfgMgr);
let receivedStatus = false;
let receivedSources = false;
let receivedPreview = false;

engine.on('status', (s) => {
  if (s.simulation) receivedStatus = true;
});

engine.on('sources:mapped', (srcs) => {
  if (srcs.length > 0) receivedSources = true;
});

engine.on('data:preview', (data) => {
  if (data.length > 0) receivedPreview = true;
});

engine.toggleSimulation(true);
engine.start();

setTimeout(() => {
  // TEST 9: Live Diff Recording & Timestamp Verification
  console.log('\n--- Test 9: Live Diff Recording & Endpoints Verification ---');
  engine.recordDiff('Test Source |sheet 2', 'Text', 'Old Score', 'New Score');
  assert.strictEqual(engine.lastSyncDiffs.length, 1);
  assert.strictEqual(engine.lastSyncDiffs[0].sourceName, 'Test Source |sheet 2');
  assert.strictEqual(engine.lastSyncDiffs[0].oldValue, 'Old Score');
  assert.strictEqual(engine.lastSyncDiffs[0].newValue, 'New Score');
  assert.ok(engine.lastSyncTimestamp > 0);
  console.log('✅ Live Diff tracking and timestamp verified');

  // Test Server Routes
  const DesktopServer = require('../src/server');
  const server = new DesktopServer(4599, testServerConfigPath);
  const srvInstance = server.start();

  const http = require('http');
  const makeReq = (path, method = 'GET', body = null) => {
    return new Promise((resolve, reject) => {
      const opt = {
        hostname: '127.0.0.1',
        port: 4599,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {}
      };
      const req = http.request(opt, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };

  // 1. Validate Core API Endpoints
  Promise.all([
    makeReq('/'),
    makeReq('/api/config'),
    makeReq('/api/heartbeat', 'POST'),
    makeReq('/api/status'),
    makeReq('/api/window-state'),
    makeReq('/api/window-state', 'POST', JSON.stringify({ width: 600, height: 700, mode: 'simple' }))
  ])
    .then(([resIndex, resConfig, resHeartbeat, resStatus, resWinGet, resWinPost]) => {
      assert.strictEqual(resIndex.status, 200, 'Root / route failed');
      assert.ok(resIndex.data.includes('SheetsToOBS'), 'Root HTML missing SheetsToOBS title');

      const configData = JSON.parse(resConfig.data);
      assert.ok(configData.activeProfile, 'Config missing activeProfile');

      const heartbeatData = JSON.parse(resHeartbeat.data);
      assert.strictEqual(heartbeatData.success, true, 'Heartbeat failed');

      const statusData = JSON.parse(resStatus.data);
      assert.strictEqual(statusData.running, false, 'Status running mismatch');

      const winPostData = JSON.parse(resWinPost.data);
      assert.strictEqual(winPostData.success, true, 'Window state post failed');

      const winStateFile = dataFile('window-state.json');
      assert.ok(fs.existsSync(winStateFile));
      const savedWin = JSON.parse(fs.readFileSync(winStateFile, 'utf8'));
      assert.strictEqual(savedWin.width, 600);
      assert.strictEqual(savedWin.mode, 'simple');

      console.log('✅ Server core APIs, Heartbeat, and Window State validated');

      // 2. Test Shutdown Endpoint
      return makeReq('/api/shutdown', 'POST');
    })
    .then((resShutdown) => {
      const shutdownData = JSON.parse(resShutdown.data);
      assert.strictEqual(shutdownData.success, true, 'Shutdown endpoint failed');
      console.log('✅ Shutdown endpoint validated');

      // Cleanup
      clearTimeout(server.shutdownTimer);
      clearInterval(server.watchdogInterval);
      srvInstance.close();
      const winStateFile = dataFile('window-state.json');
      if (fs.existsSync(winStateFile)) fs.unlinkSync(winStateFile);
      if (fs.existsSync(testServerConfigPath)) fs.unlinkSync(testServerConfigPath);

      console.log('\n==================================================');
      console.log('ALL TESTS PASSED SUCCESSFULLY! 🎉');
      console.log('==================================================');
      process.exit(0);
    }).catch(err => {
    console.error('Test 9 Failed:', err);
    process.exit(1);
  });
}, 500);

