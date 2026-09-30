'use strict';

/*
 * Roster and route CSV import/export, in whatever shape the VA's own
 * spreadsheet is in. The fixture is a real VA's network sheet, headers and
 * all: routeNumber / depICAO / arrICAO / aircraft / routeType /
 * estFlightTime / rank / notes.
 *
 *   node scripts/test-crew-csv.js
 */

const path = require('path');
const crewCsv = require(path.join('..', 'crewCsv.js'));

let failures = 0;
function T(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

const ETIHAD = [
    'routeNumber,depICAO,arrICAO,aircraft,routeType,estFlightTime,rank,notes',
    'EY101,OMAA,KJFK,"B787-9 , A380, A350-1000",Passenger,13:40,Cadets,',
    'EY102,KJFK,OMAA,"B787-9 , A380, A350-1000",Passenger,12:20,Cadets,',
    'EY11,OMAA,EGLL,"B777-300ER , B787-9",Passenger,7:30,Cadets,',
    'EY12,EGLL,OMAA,"B777-300ER , B787-9",Passenger,6:40,Cadets,',
    'EY63,OMAA,LPPT,B787-9,Passenger,7:50,Cadets,',
    'EY63,LPPT,OMAA,B787-9,Passenger,7:30,Cadets,',
    '3L452,OMAA,OLBA,A320,Passenger,4:05,Cadets,',
].join('\r\n');

console.log('\n a VA’s own sheet');
{
    const p = crewCsv.planImport(crewCsv.ROUTES_SPEC, ETIHAD, []);
    T('no errors', p.errors, []);
    T('reads its headers as ours', p.sheets[0].layout, [
        { header: 'routeNumber', key: 'flightNumber' },
        { header: 'depICAO', key: 'origin' },
        { header: 'arrICAO', key: 'destination' },
        { header: 'aircraft', key: 'aircraft' },
        { header: 'rank', key: 'minRank' },
        { header: 'notes', key: 'notes' },
    ]);
    T('…and leaves the columns we have nowhere for',
        p.sheets[0].columns.filter((c) => !c.key).map((c) => c.header), ['routeType', 'estFlightTime']);
    T('a number reused for the return leg is two routes, not one', p.create.length, 7);
    T('…each with its own airports',
        p.create.filter((r) => r.values.flightNumber === 'EY63').map((r) => `${r.values.origin}-${r.values.destination}`),
        ['OMAA-LPPT', 'LPPT-OMAA']);
    T('rows are numbered as the spreadsheet numbers them', p.create.map((r) => r.line), [2, 3, 4, 5, 6, 7, 8]);

    const stored = p.create.map((r, i) => ({ id: `r${i}`, ...r.values }));
    const again = crewCsv.planImport(crewCsv.ROUTES_SPEC, ETIHAD, stored);
    T('importing it twice changes nothing', [again.create.length, again.update.length, again.unchanged], [0, 0, 7]);

    const edited = ETIHAD.replace('EY11,OMAA,EGLL,"B777-300ER , B787-9"', 'EY11,OMAA,EGLL,A380');
    const third = crewCsv.planImport(crewCsv.ROUTES_SPEC, edited, stored);
    T('an edit lands on the right leg', third.update.map((u) => [u.id, u.values]), [['r2', { aircraft: 'A380' }]]);
}

console.log('\n choosing what a column is');
{
    const p = crewCsv.planImport(crewCsv.ROUTES_SPEC, ETIHAD, [], {
        mapping: { routeType: '+notes', estFlightTime: '+notes', aircraft: '' },
    });
    T('a column can be kept in the notes', p.create[0].values.notes, 'routeType: Passenger · estFlightTime: 13:40');
    T('…or left out', 'aircraft' in p.create[0].values, false);

    const odd = 'Leg,A,B\n1,OMAA,EGLL\n2,EGLL,OMAA\n';
    const q = crewCsv.planImport(crewCsv.ROUTES_SPEC, odd, [], { mapping: { Leg: 'flightNumber' } });
    T('airport columns are found by what is in them',
        q.create.map((r) => `${r.values.flightNumber}:${r.values.origin}-${r.values.destination}`), ['1:OMAA-EGLL', '2:EGLL-OMAA']);

    const lying = 'flight,from,to,type\nEY1,OMAA,EGLL,Passenger\n';
    const l = crewCsv.planImport(crewCsv.ROUTES_SPEC, lying, []);
    T('a header whose values do not fit is not trusted', [l.errors.length, l.create.length], [0, 1]);
    T('…and says why', l.sheets[0].columns.find((c) => c.header === 'type').reason, 'its values don’t look like kind');
}

console.log('\n a workbook');
{
    const sheets = [
        { name: 'Cover', csv: 'Etihad Virtual — route network\nUpdated weekly\n' },
        { name: 'Europe', csv: 'Etihad Virtual routes,,,\n,,,\nrouteNumber,depICAO,arrICAO,rank\nEY11,OMAA,EGLL,Cadets\n,,,\nEY12,EGLL,OMAA,Cadets\n' },
        { name: 'Americas', csv: 'Flight No,Departure Airport,Arrival Airport\nEY101,OMAA,KJFK\nFlight No,Departure Airport,Arrival Airport\nEY102,KJFK - New York,Abu Dhabi (OMAA)\n' },
        { name: 'Empty', csv: '' },
    ];
    const p = crewCsv.planImport(crewCsv.ROUTES_SPEC, sheets, []);
    T('every usable tab is read', p.create.map((r) => `${r.sheet}:${r.values.flightNumber}`),
        ['Europe:EY11', 'Europe:EY12', 'Americas:EY101', 'Americas:EY102']);
    T('…a tab that is not a table is skipped, not failed',
        p.sheets.map((s) => s.skipped || 'read'), ['none of its columns look like ours', 'read', 'read', 'it is empty']);
    T('…the header can sit below a title', p.sheets[1].headerRow, 3);
    T('…a pasted-in second header is not a route', p.errors, []);
    T('…airports written with their names still read', `${p.create[3].values.origin}-${p.create[3].values.destination}`, 'KJFK-OMAA');

    const bad = crewCsv.planImport(crewCsv.ROUTES_SPEC,
        [{ name: 'Asia', csv: 'flight,from,to\nEY1,OMAA,Tokyo\n' }, { name: 'Europe', csv: 'flight,from,to\nEY2,OMAA,EGLL\n' }], []);
    T('an error says which tab it is on', bad.errors.map((e) => [e.sheet, e.line]), [['Asia', 2]]);

    const none = crewCsv.planImport(crewCsv.ROUTES_SPEC, [{ name: 'x', csv: 'a,b\n1,2\n' }], []);
    T('a workbook with nothing of ours is refused with its tabs listed', [!!none.error, none.sheets.length], [true, 1]);
}

console.log('\n exporting in their shape');
{
    const rows = [{ id: 'r1', flightNumber: 'EY11', origin: 'OMAA', destination: 'EGLL', minRank: 'Cadets', active: true }];
    const layout = [
        { header: 'routeNumber', key: 'flightNumber' }, { header: 'depICAO', key: 'origin' },
        { header: 'arrICAO', key: 'destination' }, { header: 'rank', key: 'minRank' },
    ];
    const out = crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, layout).replace(/^﻿/, '').split('\r\n');
    T('their headers, their order, the id last', out, ['routeNumber,depICAO,arrICAO,rank,id', 'EY11,OMAA,EGLL,Cadets,r1']);
    T('…and it reads straight back in',
        crewCsv.planImport(crewCsv.ROUTES_SPEC, out.join('\n'), rows).unchanged, 1);
    const noId = crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, layout, { includeId: false }).replace(/^﻿/, '').split('\r\n')[0];
    T('the id can be left off', noId, 'routeNumber,depICAO,arrICAO,rank');
    const junk = crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, [{ header: 'x', key: 'nope' }]).replace(/^﻿/, '').split('\r\n')[0];
    T('a layout of nothing we know falls back to ours', junk.split(',')[0], 'id');
}

console.log('\n the roster');
{
    const csv = 'Pilot,Callsign,Flight Time,Fleet\nAna Peña,EY001,123:45,"B787-9, A380"\nAna Peña,EY002,1:30,A320\n';
    const p = crewCsv.planImport(crewCsv.ROSTER_SPEC, csv, []);
    T('logbook hours read as hours', p.create.map((r) => r.values.hours), [123.75, 1.5]);
    T('a fleet can be comma-separated', p.create[0].values.aircraft, ['B787-9', 'A380']);
    T('two pilots with one name are two pilots', p.create.length, 2);
    const rename = crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name,callsign\nAna Pena,EY001\n',
        [{ id: 'm1', name: 'Ana Peña', callsign: 'EY001' }]);
    T('a name fixed against a callsign still updates that pilot', rename.update.map((u) => [u.id, u.values]), [['m1', { name: 'Ana Pena' }]]);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
