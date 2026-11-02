// Loads the Prisma DMMF from schema.prisma through the pure-WASM validator (no engine download needed).
// Returns null when @prisma/prisma-schema-wasm is not installed so callers can skip.
const fs = require('fs');
const path = require('path');
module.exports = function loadDmmf() {
  let wasm;
  try { wasm = require('@prisma/prisma-schema-wasm'); } catch { return null; }
  const prismaSchema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  return JSON.parse(wasm.get_dmmf(JSON.stringify({ prismaSchema, noColor: true }))).datamodel;
};
