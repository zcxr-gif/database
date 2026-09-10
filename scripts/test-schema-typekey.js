// test-schema-typekey.js
// Guards against the schema bug that shipped three times in server.js.
//
// Mongoose's default typeKey is 'type'. So an inline array subdocument written
// like this:
//
//     crewFleet: { type: [{ _id: false, type: String, name: String }], default: [] }
//
// is NOT an array of {type, name} objects. Mongoose reads the inner object as a
// SchemaType descriptor for a *String* path and takes `name` as an option — the
// path becomes an array of strings, every write of a real row throws
// `Cast to [string] failed`, and the route reports it as a generic save failure.
//
// crewFleet, applicationForm and joinRequirements all carried this. None of the
// three had ever persisted a single row. A field named `type` has to be nested:
//
//     type: { type: String }
//
// This scans for the bare form so the next one is caught at review, not by a VA.
//
// Run:  node scripts/test-schema-typekey.js
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = ['server.js'];
const ROOT = path.resolve(__dirname, '..');

// An inline subdocument literal inside an array: [{ ... }]
const INLINE_ARRAY = /\[\{([^}]*)\}\]/g;
// A `type:` key whose value is not itself an object — i.e. the trap.
const BARE_TYPE = /(^|[{,]\s*)type:\s*(?!\{)/;

let findings = [];
for (const rel of FILES) {
    const abs = path.join(ROOT, rel);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
        let m;
        INLINE_ARRAY.lastIndex = 0;
        while ((m = INLINE_ARRAY.exec(line))) {
            if (BARE_TYPE.test(m[1])) {
                findings.push({ file: rel, line: i + 1, text: line.trim() });
            }
        }
    });
}

if (findings.length) {
    console.log(`\n✗ ${findings.length} inline array subdocument(s) declare a bare \`type:\` key.`);
    console.log('  Mongoose reads these as a String path, not an object. Nest it: type: { type: String }\n');
    for (const f of findings) {
        console.log(`  ${f.file}:${f.line}`);
        console.log(`    ${f.text.slice(0, 160)}`);
    }
    console.log('');
    process.exit(1);
}

console.log('✓ no inline array subdocument declares a bare `type:` key');
