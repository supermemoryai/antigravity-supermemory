const fs = require('node:fs');
const path = require('node:path');

function readVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'plugin.json'), 'utf-8'),
    );
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const PLUGIN_VERSION = readVersion();
// Attribution for x-sm-source and document metadata.
const SOURCE = 'antigravity';

module.exports = { PLUGIN_VERSION, SOURCE };
