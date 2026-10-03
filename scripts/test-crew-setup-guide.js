'use strict';

/*
 * The setup guide's grading (crewSetupGuide.js): a brand-new crew center, one
 * half-way through, and one that is done — graded from data, not clicks.
 *
 *   node scripts/test-crew-setup-guide.js
 */

const path = require('path');
const guide = require(path.join('..', 'crewSetupGuide.js'));

let failures = 0;
function T(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}
const state = (g, id) => (g.steps.find((s) => s.id === id) || {}).state;

console.log('\n a brand-new crew center');
{
    const g = guide.evaluate({ va: { name: 'Hawaiian Virtual' }, store: { connected: false } });
    T('the database comes first, and is next', [g.steps[0].id, state(g, 'database'), g.next], ['database', 'todo', 'database']);
    T('steps that live in it wait for it', [state(g, 'routes'), state(g, 'roster'), state(g, 'logins')], ['blocked', 'blocked', 'blocked']);
    T('steps that do not, do not', [state(g, 'ranks'), state(g, 'fleet'), state(g, 'identity')], ['todo', 'todo', 'todo']);
    T('nothing essential is done', g.progress.requiredDone, 0);
    T('every step belongs to a group the guide draws',
        g.steps.every((s) => g.groups.some((x) => x.id === s.group)), true);
}

console.log('\n half-way');
{
    const va = {
        name: 'Hawaiian Virtual', logoUrl: 'https://x/logo.png', callsign: 'HAWAIIAN ###AG',
        ranks: [{ name: 'Trainee', minHours: 0 }, { name: 'Second Officer', minHours: 15 }, { name: 'First Officer', minHours: 40, requiresCheck: true }],
        crewFleet: [{ type: 'Airbus A321' }],
    };
    const g = guide.evaluate({
        va, store: { connected: true, ok: true, provisioned: true, outdated: true },
        counts: { members: 17, active: 17, routes: 0, withoutLogin: 12, neverSignedIn: 3 },
    });
    T('an outdated database needs a hand', state(g, 'database'), 'attention');
    T('the callsign sample is the one pilots fly', g.steps.find((s) => s.id === 'identity').callsignSample, 'HAWAIIAN 001AG');
    T('a ladder with a check-ride is done, and says so',
        [state(g, 'ranks'), /check-ride/.test(g.steps.find((s) => s.id === 'ranks').summary)], ['done', true]);
    T('pilots who cannot sign in need a hand', [state(g, 'logins'), /12 pilots/.test(g.steps.find((s) => s.id === 'logins').summary)], ['attention', true]);
    T('next is the first essential not done — the one-click update first', g.next, 'database');
    T('sharing waits for the essentials', state(g, 'launch'), 'todo');
}

console.log('\n done');
{
    const g = guide.evaluate({
        va: {
            logoUrl: 'x', callsign: 'HAWAIIAN ###AG', joinMode: 'application', crewDiscordInvite: 'https://discord.gg/x',
            ranks: [{ name: 'A', minHours: 0 }, { name: 'B', minHours: 10 }], crewFleet: [{ type: 'A321' }],
            roles: [{ name: 'CEO' }], crewWebhooks: { pireps: 'https://discord.com/api/webhooks/1/x' },
            crewEmailConfigured: true, ifOrganizationId: 'org',
        },
        store: { connected: true, ok: true, provisioned: true },
        counts: { members: 2, active: 2, routes: 40, withoutLogin: 0, neverSignedIn: 0 },
        staffAccounts: 1,
    });
    T('every step is done', g.steps.filter((s) => s.state !== 'done').map((s) => s.id), []);
    T('nothing is next', g.next, null);
    T('progress adds up', [g.progress.done, g.progress.total, g.progress.requiredDone, g.progress.required],
        [g.steps.length, g.steps.length, g.progress.required, g.progress.required]);
}

console.log('\n a database that will not answer');
{
    const g = guide.evaluate({ va: {}, store: { connected: true, ok: false, error: 'Invalid API key' }, counts: { members: 3 } });
    T('it says what is wrong', [state(g, 'database'), /Invalid API key/.test(g.steps[0].summary)], ['attention', true]);
    T('and does not trust counts it could not have read', state(g, 'roster'), 'blocked');
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
