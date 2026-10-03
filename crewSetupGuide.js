'use strict';

/*
 * crewSetupGuide.js
 * The setup guide: every step a crew center needs, in the order it needs
 * them, and how far along each one is. v22.
 *
 * WHY
 * ---
 * Everything a VA has to do to run here already existed — connecting their
 * database, a rank ladder, a fleet, a network, a roster, logins, a join form,
 * Discord alerts — but it was spread across a settings drawer with five tabs,
 * a recruitment drawer, the roster, the network and the VA portal, and nothing
 * said which of it mattered first. The commonest way a new crew center stalled
 * was not a missing feature; it was an owner who connected Supabase, looked at
 * the rest, and did not know where to go next.
 *
 * So this is the one place that knows the order, and answers "what's left?"
 * from the VA's actual data rather than from which buttons somebody pressed —
 * a ladder imported from a file and a ladder typed in are the same ladder, and
 * a step is only done when the thing it is about exists.
 *
 * WHAT A STEP IS
 * --------------
 *   state      done       the thing exists
 *              todo       it does not yet
 *              attention  it exists and something about it needs a hand
 *                         (an outdated database, pilots who cannot sign in)
 *              blocked    it needs the database, and there is not one yet
 *   required   the crew center does not really work without it. Everything
 *              else is worth doing and can wait.
 *
 * This module only grades. The route in server.js gathers the inputs, and the
 * dashboard draws the guide and carries out the actions — with the same
 * editors and the same endpoints as everywhere else, so there is no second way
 * to set anything up that can drift from the first.
 *
 * Pure: no database, no network. scripts/test-crew-setup-guide.js runs it.
 */

const crewRanks = require('./crewRanks');
const crewCallsign = require('./crewCallsign');

const GROUPS = [
    { id: 'foundations', title: 'Foundations' },
    { id: 'airline', title: 'Your airline' },
    { id: 'people', title: 'Your pilots' },
    { id: 'connections', title: 'Connections' },
    { id: 'launch', title: 'Go live' },
];

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const has = (v) => typeof v === 'string' ? v.trim().length > 0 : !!v;

/**
 * Where the database stands, from crewStore's health answer.
 * @returns {{ready: boolean, step: Object}}
 */
function storeStep(store) {
    const s = store || {};
    let state = 'todo';
    let summary = 'Your pilots, flights and logins live in your own free Supabase project. Paste one token and it is set up for you.';
    if (s.connected && s.ok && s.provisioned !== false) {
        state = s.outdated ? 'attention' : 'done';
        summary = s.outdated
            ? 'Connected, but on an older version — one button brings it up to date. Your data is not touched.'
            : 'Connected and up to date.';
    } else if (s.connected) {
        state = 'attention';
        summary = s.error
            ? `Connected, but it is not answering: ${String(s.error).slice(0, 160)}`
            : 'Connected, but the tables are not set up yet. Run the setup again to finish it.';
    }
    return {
        ready: !!(s.connected && s.ok && s.provisioned !== false),
        step: { id: 'database', group: 'foundations', title: 'Connect your database', required: true, state, summary },
    };
}

/**
 * Grade every step.
 *
 * @param {Object} input
 * @param {Object} input.va      the VA document (lean)
 * @param {Object} input.store   { connected, ok, provisioned, outdated, error }
 * @param {Object|null} input.counts  from the store, or null when it is not
 *        reachable: { members, active, routes, withoutLogin, neverSignedIn }
 * @param {number} [input.staffAccounts]  central staff logins for this VA
 * @returns {{groups, steps, progress: {required, requiredDone, total, done}, next}}
 */
function evaluate({ va = {}, store = {}, counts = null, staffAccounts = 0 } = {}) {
    const steps = [];
    const db = storeStep(store);
    steps.push(db.step);
    const c = db.ready && counts ? counts : null;
    const needsDb = (step) => (c ? step : {
        ...step, state: 'blocked', summary: 'Connect your database first — this lives in it.',
    });

    // --- Foundations -------------------------------------------------------
    const fmt = crewCallsign.primaryFormat(va);
    const identityMissing = [];
    if (!has(va.logoUrl)) identityMissing.push('a logo');
    if (!fmt) identityMissing.push('a callsign');
    steps.push({
        id: 'identity', group: 'foundations', title: 'Name, logo and callsign', required: true,
        state: identityMissing.length ? 'todo' : 'done',
        summary: identityMissing.length
            ? `Still needs ${identityMissing.join(' and ')}. The callsign is what your pilots fly under, and what live tracking matches their flights by.`
            : `Pilots fly as ${crewCallsign.sample(fmt)}, ${crewCallsign.build(fmt, 2)} and so on.`,
        callsignSample: fmt ? crewCallsign.sample(fmt) : '',
    });

    const ladder = crewRanks.normalizeLadder(va.ranks);
    const checks = ladder.filter((r, i) => i > 0 && r.requiresCheck).length;
    steps.push({
        id: 'ranks', group: 'foundations', title: 'Rank ladder', required: true,
        state: ladder.length >= 2 ? 'done' : 'todo',
        summary: ladder.length >= 2
            ? `${plural(ladder.length, 'rank')}, ${ladder[0].name} to ${ladder[ladder.length - 1].name}${checks ? `, ${plural(checks, 'check-ride')}` : ''}. Pilots are promoted on hours automatically.`
            : (ladder.length === 1
                ? 'One rank is not a ladder yet. Pick a template or add the ranks your pilots climb.'
                : 'Pick a ready-made ladder or build your own. Ranks follow hours, so promotions happen by themselves.'),
    });

    // --- Your airline ------------------------------------------------------
    const fleet = Array.isArray(va.crewFleet) ? va.crewFleet.filter((f) => f && has(f.type)) : [];
    steps.push({
        id: 'fleet', group: 'airline', title: 'Fleet', required: true,
        state: fleet.length ? 'done' : 'todo',
        summary: fleet.length
            ? `${plural(fleet.length, 'aircraft type')}.`
            : 'The aircraft your pilots fly. Type an airline or a livery and the aircraft is found for you.',
    });
    steps.push(needsDb({
        id: 'routes', group: 'airline', title: 'Route network', required: true,
        state: c && c.routes ? 'done' : 'todo',
        summary: c && c.routes
            ? `${plural(c.routes, 'route')}.`
            : 'Copy a real airline’s network, import a spreadsheet, or add routes one at a time.',
    }));
    const roles = Array.isArray(va.roles) ? va.roles.filter((r) => r && has(r.name)) : [];
    steps.push({
        id: 'roles', group: 'airline', title: 'Staff positions', required: false,
        state: roles.length ? 'done' : 'todo',
        summary: roles.length
            ? `${plural(roles.length, 'position')} — ${roles.slice(0, 3).map((r) => r.name).join(', ')}${roles.length > 3 ? '…' : ''}.`
            : 'The titles shown on your roster and website — CEO, Head of Operations and so on.',
    });

    // --- Your pilots -------------------------------------------------------
    steps.push(needsDb({
        id: 'roster', group: 'people', title: 'Roster', required: true,
        state: c && c.members ? 'done' : 'todo',
        summary: c && c.members
            ? `${plural(c.members, 'pilot')} on the roster.`
            : 'Bring your pilots over from a spreadsheet or a Discord bot export — hours, ranks and join dates included — or add them by hand.',
    }));
    if (c && c.members) {
        steps.push({
            id: 'logins', group: 'people', title: 'Pilot logins', required: true,
            state: c.withoutLogin ? 'attention' : 'done',
            summary: c.withoutLogin
                ? `${plural(c.withoutLogin, 'pilot')} can’t sign in yet. Set them up together and send each one a link to choose their password.`
                : (c.neverSignedIn
                    ? `Everyone has a login; ${plural(c.neverSignedIn, 'pilot hasn’t', 'pilots haven’t')} signed in yet.`
                    : 'Everyone on the roster can sign in.'),
        });
    } else {
        steps.push(needsDb({
            id: 'logins', group: 'people', title: 'Pilot logins', required: true, state: 'todo',
            summary: 'Once pilots are on the roster, give them all logins in one go.',
        }));
    }
    const recruitingSet = va.joinMode === 'free' || has(va.crewDiscordInvite)
        || (Array.isArray(va.applicationForm) && va.applicationForm.length > 0);
    steps.push({
        id: 'recruiting', group: 'people', title: 'How new pilots join', required: false,
        state: recruitingSet ? 'done' : 'todo',
        summary: recruitingSet
            ? `${va.joinMode === 'free' ? 'Anyone can join straight away' : 'New pilots apply and staff accept them'}${has(va.crewDiscordInvite) ? ', and get your Discord invite' : ''}.`
            : 'Open joining or applications, the questions you ask, and the Discord invite new pilots get.',
    });
    const staffRoles = Array.isArray(va.staffRoles) ? va.staffRoles.length : 0;
    steps.push({
        id: 'team', group: 'people', title: 'Staff and permissions', required: false,
        state: staffAccounts > 0 ? 'done' : 'todo',
        summary: staffAccounts > 0
            ? `${plural(staffAccounts, 'staff login')}${staffRoles ? `, ${plural(staffRoles, 'permission role')}` : ''}.`
            : 'Give your admins their own logins, each with only the permissions they need.',
    });

    // --- Connections -------------------------------------------------------
    const hooks = va.crewWebhooks || {};
    const hookCount = Object.values(hooks).filter((v) => typeof v === 'string' && v.trim()).length
        + (va.hasLegacyWebhook ? 1 : 0);
    steps.push({
        id: 'alerts', group: 'connections', title: 'Discord alerts', required: false,
        state: hookCount ? 'done' : 'todo',
        summary: hookCount
            ? `Posting to ${plural(hookCount, 'channel')}.`
            : 'Applications, flight reports, promotions and new routes posted to your Discord as they happen.',
    });
    steps.push({
        id: 'email', group: 'connections', title: 'Email', required: false,
        state: va.crewEmailConfigured ? 'done' : 'todo',
        summary: va.crewEmailConfigured
            ? 'Sending from your own provider.'
            : 'Optional. Lets pilots reset their own password and get decisions by email.',
    });
    steps.push({
        id: 'infinite-flight', group: 'connections', title: 'Infinite Flight', required: false,
        state: has(va.ifOrganizationId) ? 'done' : 'todo',
        summary: has(va.ifOrganizationId)
            ? `Linked to ${va.ifOrganizationName || 'your Infinite Flight organization'}.`
            : 'Optional. Link your Infinite Flight organization to sync aircraft and schedules.',
    });

    // --- Go live -----------------------------------------------------------
    const essentials = steps.filter((s) => s.required);
    const essentialsDone = essentials.every((s) => s.state === 'done');
    steps.push({
        id: 'launch', group: 'launch', title: 'Share your crew center', required: false,
        state: essentialsDone ? 'done' : 'todo',
        summary: essentialsDone
            ? 'Everything essential is in place. Share the sign-in and join links.'
            : 'Once the essentials are done, share the links with your pilots.',
    });

    const required = steps.filter((s) => s.required);
    const next = steps.find((s) => s.required && s.state !== 'done' && s.state !== 'blocked')
        || steps.find((s) => s.state === 'attention')
        || steps.find((s) => !s.required && s.state === 'todo' && s.id !== 'launch')
        || null;
    return {
        groups: GROUPS,
        steps,
        progress: {
            required: required.length,
            requiredDone: required.filter((s) => s.state === 'done').length,
            total: steps.length,
            done: steps.filter((s) => s.state === 'done').length,
        },
        next: next ? next.id : null,
    };
}

module.exports = { evaluate, GROUPS };
