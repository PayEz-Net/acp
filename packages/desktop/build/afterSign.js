const { notarize } = require('@electron/notarize');

/**
 * electron-builder afterSign hook.
 * Notarizes the .app bundle on macOS after code signing.
 *
 * Requires these env vars (do NOT commit them):
 *   APPLE_ID                — your Apple ID email
 *   APPLE_APP_SPECIFIC_PASSWORD — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID           — 10-character Apple Developer Team ID
 *
 * If env vars are missing, notarization is skipped with a warning.
 */
module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.warn('[afterSign] Skipping notarization — missing one or more env vars:');
    console.warn('  APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID');
    console.warn('  Set them in .env and export before building (see .env.example).');
    return;
  }

  console.log(`[afterSign] Notarizing ${appPath} with team ${teamId}...`);

  try {
    await notarize({
      appPath,
      appleId,
      appleIdPassword,
      teamId,
      tool: 'notarytool',
    });
    console.log('[afterSign] Notarization complete ✅');
  } catch (err) {
    console.error('[afterSign] Notarization failed ❌');
    console.error(err);
    throw err;
  }
};
