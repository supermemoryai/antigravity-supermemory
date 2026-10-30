#!/usr/bin/env node
const path = require('node:path');

const { main } = require(
  path.join(__dirname, '..', '..', '..', 'scripts', 'cli.js'),
);

main(['login', '--background', ...process.argv.slice(2)]);
