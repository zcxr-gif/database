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
        p.sheets.map((s) => s.skipped || 'read'), ['it isn’t laid out as a table', 'read', 'read', 'it is empty']);
    T('…the header can sit below a title', p.sheets[1].headerRow, 3);
    T('…a pasted-in second header is not a route', p.errors, []);
    T('…airports written with their names still read', `${p.create[3].values.origin}-${p.create[3].values.destination}`, 'KJFK-OMAA');

    const bad = crewCsv.planImport(crewCsv.ROUTES_SPEC,
        [{ name: 'Asia', csv: 'flight,from,to\nEY1,OMAA,Tokyo\n' }, { name: 'Europe', csv: 'flight,from,to\nEY2,OMAA,EGLL\n' }], []);
    T('an error says which tab it is on', bad.errors.map((e) => [e.sheet, e.line]), [['Asia', 2]]);

    const none = crewCsv.planImport(crewCsv.ROUTES_SPEC, [{ name: 'x', csv: 'a,b\n1,2\n' }], []);
    T('a workbook with nothing of ours is refused with its tabs listed', [!!none.error, none.sheets.length], [true, 1]);
}

console.log('\n almost any sheet');
{
    const iata = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'flight,from,to\nEY101,AUH,JFK\n', []);
    T('three-letter codes become ICAO', `${iata.create[0].values.origin}-${iata.create[0].values.destination}`, 'OMAA-KJFK');

    const pair = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'Flight,Route,Equipment\nEY101,OMAA-KJFK,A380\nEY102,KJFK → OMAA,A380\n', []);
    T('a leg in one "route" column is both airports',
        pair.create.map((r) => `${r.values.origin}-${r.values.destination}`), ['OMAA-KJFK', 'KJFK-OMAA']);
    T('…and says it read them that way', pair.sheets[0].columns.find((c) => c.header === 'Route').key, crewCsv.TO_PAIR);

    const bare = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'EY101,OMAA,KJFK,B787-9\nEY102,KJFK,OMAA,B787-9\n', []);
    T('a file with no header row keeps its first row', bare.create.length, 2);
    T('…and works out the columns from what is in them',
        bare.create.map((r) => `${r.values.flightNumber}:${r.values.origin}-${r.values.destination}`), ['EY101:OMAA-KJFK', 'EY102:KJFK-OMAA']);
    T('…calling them what a spreadsheet would', bare.sheets[0].preview.headers, ['Column A', 'Column B', 'Column C', 'Column D']);
    const fleetToo = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'EY101,AUH-JFK,A380\nEY102,JFK-AUH,A380\nEY103,AUH-LHR,A380\n', []);
    T('an aircraft column is not mistaken for flight numbers',
        fleetToo.sheets[0].columns.map((c) => c.key), ['flightNumber', crewCsv.TO_PAIR, '']);

    const units = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'from,to,distance\nOMAA,KJFK,"5,960 nm"\nOMAA,EGLL,"5,500 km"\n', []);
    T('distances with units are nautical miles', units.create.map((r) => r.values.distanceNm), [5960, 2970]);

    const typo = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'from,to\nOMAA,KJFQ\n', []);
    T('an airport nobody has heard of still imports', typo.create.length, 1);
    T('…but is flagged', [typo.warningCount, typo.sheets[0].preview.rows[0].cells[1].w], [1, 'KJFQ isn’t in our airport list — check it’s right']);
}

console.log('\n the preview');
{
    const existing = [{ id: 'r1', flightNumber: 'EY11', origin: 'OMAA', destination: 'EGLL', aircraft: 'A380' }];
    const csv = 'routeNumber,depICAO,arrICAO,aircraft\nEY11,OMAA,EGLL,A380\nEY12,EGLL,OMAA,B787-9\nEY11,OMAA,EGLL,B777\nEY13,OMAA,Tokyo,A320\nEY14,AUH,LHR,A320\nEY14,AUH,LHR,A320\n';
    const p = crewCsv.planImport(crewCsv.ROUTES_SPEC, csv, existing);
    const rows = p.sheets[0].preview.rows;
    T('every row says what will happen to it', rows.map((r) => r.status),
        ['unchanged', 'create', 'update', 'error', 'create', 'merged']);
    T('…an update names what changes', rows[2].changes, ['aircraft']);
    T('…a bad cell carries its own message, in their column name', rows[3].cells[2].e, 'arrICAO “Tokyo” is not an airport code');
    T('…a cell we changed shows what it became', [rows[4].cells[1].r, rows[4].cells[2].r], ['OMAA', 'EGLL']);
    T('…a repeated line points at the one it joins', rows[5].message, 'same route as row 6 — combined with it');
    T('the columns are listed with what each became', p.sheets[0].preview.targets, ['flightNumber', 'origin', 'destination', 'aircraft']);

    const many = 'from,to\n' + Array.from({ length: 80 }, (_, i) => (i === 70 ? 'OMAA,Nowhere' : 'OMAA,EGLL')).join('\n');
    const big = crewCsv.planImport(crewCsv.ROUTES_SPEC, many, []).sheets[0].preview;
    T('a long sheet shows its first rows and every problem', [big.rows.length, big.rows[big.rows.length - 1].line, big.more], [31, 72, 49]);

    const none = crewCsv.planImport(crewCsv.ROUTES_SPEC, 'Alpha,Beta\nfoo,bar\n', []);
    T('an unreadable sheet is still shown, so it can be mapped', none.sheets[0].preview.rows[0].cells.map((c) => c.v), ['foo', 'bar']);
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
    const paired = crewCsv.toCsv(crewCsv.ROUTES_SPEC, rows, [{ header: 'Flight', key: 'flightNumber' }, { header: 'Route', key: crewCsv.TO_PAIR }], { includeId: false })
        .replace(/^\uFEFF/, '').split('\r\n');
    T('a one-column leg goes back out as one column', paired, ['Flight,Route', 'EY11,OMAA-EGLL']);
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

console.log('\n a roster from a Discord bot');
{
    // The columns a VA moving here actually arrives with.
    const crewRosterCsv = require(path.join('..', 'crewRosterCsv.js'));
    const BOT = [
        'pilot,if username,callsign,rank,hours,role,joined',
        'Elijah,Elijah.Kycz,001AG,First Officer,40.1,owner,2026-08-02',
        'dakotahgo,dakotahgo,005AG,Trainee,4.2,admin,2026-08-23',
        'Andrew Graham,AndrewGraham,100AG,First Officer,47.0,pilot,2026-08-29',
        'Bizjetguy6,bizjetguy6,003AG,Second Officer,15.0,pilot,8/30/2026',
        'znorth,Captain_zane,106AG,Captain,20.1,pilot,2026-09-26',
        'SKY,SKY,808AG,First Officer,12,Pilot,',
    ].join('\n');
    const va = {
        ranks: [
            { name: 'Trainee', minHours: 0 }, { name: 'Second Officer', minHours: 15 },
            { name: 'First Officer', minHours: 40, requiresCheck: true },
        ],
        roles: [{ name: 'Admin' }],
    };
    const { prepare, extra, ladder } = crewRosterCsv.prepareFor(va);
    const p = crewCsv.planImport(crewCsv.ROSTER_SPEC, BOT, [], { prepare });
    const cols = p.sheets[0].columns.map((c) => [c.header, c.key]);
    T('every column is read', cols, [['pilot', 'name'], ['if username', 'ifcName'], ['callsign', 'callsign'],
        ['rank', 'rank'], ['hours', 'hours'], ['role', 'role'], ['joined', 'joined']]);
    T('the IF username lands on the pilot', p.create[0].values.ifcName, 'Elijah.Kycz');
    T('join dates read, US slashes included', p.create.map((r) => r.values.joined),
        ['2026-08-02', '2026-08-23', '2026-08-29', '2026-08-30', '2026-09-26', undefined]);
    T('"pilot" is no role; a role the VA has takes its spelling', p.create.map((r) => r.values.role),
        ['owner', 'Admin', '', '', '', '']);
    T('rank kept only where it signs off a check-ride', p.create.map((r) => r.values.rank),
        ['First Officer', undefined, 'First Officer', undefined, undefined, 'First Officer']);
    const e = extra();
    T('owner and admin are counted, not granted', e.staffRoleCount, 2);
    T('a rank not on the ladder is named', e.unknownRanks, ['Captain']);
    T('…and its row warned, not refused', p.errors.length, 0);
    T('rank and hours that disagree are warned', p.warningCount, 2);
    T('the check-ride is signed off on create', crewRosterCsv.importExtras(p.create[0].values, ladder, null),
        { createdAt: '2026-08-02T00:00:00.000Z', checksPassed: ['First Officer'] });
    T('…and added to, not replaced, on update',
        crewRosterCsv.importExtras({ rank: 'First Officer' }, ladder, { checksPassed: ['Other'] }), { checksPassed: ['Other', 'First Officer'] });
    T('…and not re-added', crewRosterCsv.importExtras({ rank: 'First Officer' }, ladder, { checksPassed: ['first officer'] }), {});

    // Round trip: what export writes, import reads as unchanged.
    const member = { _id: 'm1', name: 'Elijah', callsign: '001AG', hours: 40.1, role: 'owner', aircraft: [], status: 'active',
        ifcName: 'Elijah.Kycz', ifUserId: '', checksPassed: ['First Officer'], createdAt: new Date('2026-08-02T00:00:00Z') };
    const row = crewRosterCsv.csvRow(member, ladder, new Map([['m1', 'elijah']]));
    T('export derives the rank and dates the row', [row.rank, row.joined, row.login], ['First Officer', '2026-08-02', 'elijah']);
    const out = crewCsv.toCsv(crewCsv.ROSTER_SPEC, [row]);
    const back = crewCsv.planImport(crewCsv.ROSTER_SPEC, out, [row], { prepare: crewRosterCsv.prepareFor(va).prepare });
    T('an exported roster re-imports as a no-op', [back.create.length, back.update.length, back.unchanged, back.errors], [0, 0, 1, []]);
    T('the login column is never read back', back.columns.includes('login'), false);
    T('…nor reported missing', crewCsv.planImport(crewCsv.ROSTER_SPEC, 'name\nX\n', []).missing.includes('login'), false);

    const dates = crewCsv.planImport(crewCsv.ROSTER_SPEC,
        'name,joined\nA,31/12/2025\nB,2 Aug 2026\nC,2026-02-31\nD,2099-01-01\n', []);
    T('day-first when the day says so; month names; impossible and future dates refused',
        [dates.create.map((r) => r.values.joined), dates.errors.length], [['2025-12-31', '2026-08-02'], 2]);
}

console.log('\n several roster sheets at once');
{
    // Two files from two systems — or two tabs of one workbook — with
    // different headings, one pilot in both, and a tab that is not a roster.
    const crewRosterCsv = require(path.join('..', 'crewRosterCsv.js'));
    const sheets = [
        { name: 'Discord bot', csv: 'pilot,if username,callsign,rank,hours,role,joined\nSKY,SKY,808AG,First Officer,51.4,pilot,2026-08-23\nRT Carter,RTCarter1,004AG,First Officer,83.9,pilot,2026-08-19\n' },
        { name: 'Old sheet', csv: 'Hawaiian Virtual roster\n\nPilot Name,Pilot ID,Flight Time,Status\nIsaac Crabtree,403AG,19:30,active\nSKY,808AG,51:24,active\n' },
        { name: 'Notes', csv: 'Remember to post the event\n' },
    ];
    const { prepare } = crewRosterCsv.prepareFor({ ranks: [] });
    const p = crewCsv.planImport(crewCsv.ROSTER_SPEC, sheets, [], { prepare });
    T('every pilot once, across both sheets', p.create.map((r) => r.values.name).sort(), ['Isaac Crabtree', 'RT Carter', 'SKY']);
    T('each sheet read under its own headings', p.sheets.map((s) => s.rows), [2, 2, 0]);
    T('a title above the headings is skipped', p.sheets[1].headerRow, 3);
    T('the pilot in both sheets is combined, later values winning', p.create.find((r) => r.values.name === 'SKY').values,
        { name: 'SKY', ifcName: 'SKY', callsign: '808AG', hours: 51.4, role: '', joined: '2026-08-23', status: 'active' });
    T('a tab that is not a roster is skipped, not refused', [!!p.sheets[2].skipped, p.errors.length], [true, 0]);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
