// Import Bhutan OSM named nodes into MySQL places table.
//
// Prerequisites:
//   brew install osmium-tool   (macOS)  /  apt install osmium-tool  (Linux)
//
// Usage:
//   # 1. Download
//   wget https://download.geofabrik.de/asia/bhutan-latest.osm.pbf
//
//   # 2. Filter to named nodes only (much smaller)
//   osmium tags-filter bhutan-latest.osm.pbf n/name -o bhutan-named-nodes.osm.pbf
//
//   # 3. Export to newline-delimited GeoJSON
//   osmium export bhutan-named-nodes.osm.pbf -f geojsonseq -o bhutan-places.geojsonl
//
//   # 4. Run this script
//   node src/scripts/importOsmPlaces.js bhutan-places.geojsonl

import fs from 'fs';
import readline from 'readline';
import { mysqlPool } from '../db/mysql.js';

const FILE  = process.argv[2] || 'bhutan-places.geojsonl';
const BATCH = 500;

async function run() {
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }

  const conn = await mysqlPool.getConnection();
  let buf = [], total = 0, skipped = 0;

  const flush = async () => {
    if (!buf.length) return;

    // Build parameterised bulk INSERT
    const placeholders = buf.map(() =>
      '(?,?,?,?,?,?,?,?,?,ST_GeomFromText(CONCAT(\'POINT(\',?,\' \',?,\')\')),?)'
    ).join(',');

    const flat = buf.flatMap(r => r);

    await conn.query(
      `INSERT IGNORE INTO places
         (osm_id, name, name_en, amenity, tourism, shop, place, lat, lon, location, tags)
       VALUES ${placeholders}`,
      flat
    );

    total += buf.length;
    process.stdout.write(`\rimported ${total} rows (skipped ${skipped})`);
    buf = [];
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.replace(/^\x1e/, '').trim();
    if (!trimmed || trimmed === ',') continue;

    let f;
    try {
      f = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }

    const p   = f.properties || {};
    const geo = f.geometry;

    if (!geo || geo.type !== 'Point' || !p.name) {
      skipped++;
      continue;
    }

    const [lon, lat] = geo.coordinates;

    // Parse osm_id from "@id" which looks like "node/12345678"
    let osmId = null;
    if (p['@id']) {
      const m = String(p['@id']).match(/(\d+)$/);
      if (m) osmId = Number(m[1]);
    }

    buf.push([
      osmId,
      p.name,
      p['name:en']  || null,
      p.amenity     || null,
      p.tourism     || null,
      p.shop        || null,
      p.place       || null,
      lat,
      lon,
      lon,   // used in CONCAT('POINT(',lon,' ',lat,')')
      lat,
      JSON.stringify(p),
    ]);

    if (buf.length >= BATCH) await flush();
  }

  await flush();

  conn.release();
  await mysqlPool.end();

  console.log(`\nDone — ${total} rows inserted, ${skipped} skipped.`);
}

run().catch(e => {
  console.error('\nImport failed:', e.message);
  process.exit(1);
});
