'use strict';

/*
 * crewRosterCsv.js
 * What a roster from somewhere else means here, column by column. v22.
 *
 * WHY THIS IS NOT IN crewCsv.js
 * -----------------------------
 * crewCsv.js reads cells: it knows "40.1" is a number and "2026-08-02" is a
 * date. It does not know this VA's rank ladder or its roles, and three of the
 * columns every arriving roster has cannot be copied without them:
 *
 *   rank    is derived from hours here and never stored (crewRanks.js). A rank
 *           cell is the old system's word that the pilot HOLDS that rank. That
 *           is only news where a rung needs a check-ride — then it is the record
 *           that they passed it, and gets signed off. Everywhere else it is a
 *           claim to compare with the hours, and a mismatch is worth a warning,
 *           not a write.
 *   role    "pilot" in a bot's export is the absence of a role, not a role.
 *           "admin" and "owner" opened that bot's admin panel; here they open
 *           nothing — dashboard access is a staff account, never a cell a
 *           spreadsheet can write — and the preview says so once.
 *   joined  is the roster row's created_at, which the retention sweep runs a
 *           new pilot's first-flight clock from. Imported without it, every
 *           pilot is on day one.
 *
 * The file that comes from a Discord bot's roster command —
 *   pilot, if username, callsign, rank, hours, role, joined
 * — is the case this was built around, and scripts/test-crew-csv.js imports
 * one.
 */

const crewRanks = require('./crewRanks');

const day = (d) => {
    const t = d ? new Date(d) : null;
    return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : '';
};

// Unless the VA has a role by one of these names, it becomes no role.
const GENERIC_ROLES = new Set(['pilot', 'pilots', 'member', 'members', 'user', 'crew', 'none', '-']);
// Roles that, in the system the file came from, meant somebody could run it.
const STAFFISH_ROLES = /\b(owner|admin|administrator|staff|ceo|coo|founder|manager|moderator|mod)\b/i;

/** The check-ride rungs a pilot holding `rankName` must have passed. */
function checksForRank(ladder, rankName) {
    const at = crewRanks.rankIndex(ladder, rankName);
    if (at < 1) return [];
    return ladder.slice(1, at + 1).filter((r) => r.requiresCheck).map((r) => r.name);
}

/**
 * The `prepare` hook for crewCsv.planImport, for this VA.
 *
 * @param {Object} va        needs `ranks` and `roles`
 * @param {Function} shape   the VA's callsign normaliser
 * @returns {{prepare: Function, extra: Function, ladder: Array}}
 *   `extra` is what the preview says once for the whole file.
 */
function prepareFor(va, shape = (cs) => cs) {
    const ladder = crewRanks.normalizeLadder(va && va.ranks);
    const roles = new Map((Array.isArray(va && va.roles) ? va.roles : [])
        .filter((r) => r && r.name).map((r) => [String(r.name).trim().toLowerCase(), String(r.name).trim()]));
    const staffRows = new Set();
    const unknownRanks = new Set();

    const prepare = (values, row) => {
        const v = { ...values };
        if (v.callsign) v.callsign = shape(v.callsign);
        // Blank is "not said", not "never joined".
        if (v.joined === '') delete v.joined;

        if (typeof v.role === 'string' && v.role) {
            const key = v.role.trim().toLowerCase();
            if (STAFFISH_ROLES.test(v.role) && row) staffRows.add(row);
            if (roles.has(key)) v.role = roles.get(key);
            else if (GENERIC_ROLES.has(key)) v.role = '';
        }

        // Kept in `values` only when it signs off a check-ride, and then under
        // the ladder's own spelling — so an unchanged rank plans as
        // "unchanged" rather than as an update that writes nothing.
        if ('rank' in v) {
            const said = String(v.rank || '').trim();
            delete v.rank;
            if (!said || !ladder.length) return v;
            const at = crewRanks.rankIndex(ladder, said);
            if (at < 0) {
                unknownRanks.add(said);
                if (row) row.warn = row.warn || `rank “${said}” isn’t on your ladder — their rank will follow their hours`;
                return v;
            }
            const checks = checksForRank(ladder, said);
            if (checks.length) v.rank = ladder[at].name;
            if (v.hours !== undefined && row) {
                const held = crewRanks.rankForHours(ladder, v.hours, checks);
                if (held && held.name !== ladder[at].name) {
                    row.warn = row.warn || `listed as ${ladder[at].name}, but ${v.hours} h is ${held.name} on your ladder — rank follows hours`;
                }
            }
        }
        return v;
    };

    const extra = () => ({
        staffRoleCount: staffRows.size,
        unknownRanks: [...unknownRanks].slice(0, 12),
        hasLadder: ladder.length > 0,
    });
    return { prepare, extra, ladder };
}

/**
 * A roster row as the CSV code sees it: the stored row plus the derived
 * columns. Export writes it, and import compares against it, so a file that
 * goes out and comes back is a no-op.
 *
 * @param {Map} [loginOf]  member id -> login username
 */
function csvRow(m, ladder, loginOf) {
    const held = ladder && ladder.length ? crewRanks.rankForHours(ladder, m.hours, m.checksPassed) : null;
    return {
        id: m._id, name: m.name, callsign: m.callsign, hours: m.hours, role: m.role,
        aircraft: m.aircraft || [], status: m.status, ifcName: m.ifcName || '', ifUserId: m.ifUserId || '',
        rank: held ? held.name : '', joined: day(m.createdAt),
        login: (loginOf && loginOf.get(String(m._id))) || '',
        checksPassed: m.checksPassed || [],
    };
}

/**
 * What an imported row writes beyond cleanMember: the join date, and the
 * check-rides its rank says were passed (added to, never taken from).
 */
function importExtras(values, ladder, before) {
    const out = {};
    if (values.joined) out.createdAt = `${values.joined}T00:00:00.000Z`;
    if (values.rank) {
        const had = (before && before.checksPassed) || [];
        const add = checksForRank(ladder, values.rank)
            .filter((c) => !had.some((h) => String(h).toLowerCase() === c.toLowerCase()));
        if (add.length) out.checksPassed = [...had, ...add];
    }
    return out;
}

module.exports = { prepareFor, csvRow, importExtras, checksForRank, GENERIC_ROLES };
