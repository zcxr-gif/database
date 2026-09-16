'use strict';

/*
 * crewCallsign.js
 * Pilot callsigns for a crew center: what shape one takes, whether it is
 * already spoken for, and who is allowed to hold a low number.
 *
 * WHY THIS EXISTS
 * ---------------
 * A VA registers its callsign as a MASK — "AEROMEXICO ###MX", "OCEAN ##VA",
 * "BAW ###" — where the "#" stand in for the pilot's number and the trailing
 * letters are the airline's tag. The mask is what the VA told its pilots they
 * would fly, and it is what the live-flight matcher reads a real in-game
 * callsign against (callsignFitsVaMode in server.js).
 *
 * The join form did not use it. It pasted the prefix and the number together
 * and saved the result — "AEROMEXICO001" — which is wrong three ways at once:
 *
 *   * no separator, so it is not the shape the mask promised;
 *   * no tag, so "AEROMEXICO001" IS Aeromexico, the real airline, rather than
 *     somebody flying for a VA of it. Under 'exact' or 'strict' matching the
 *     pilot's flights then match no registered callsign and are attributed to
 *     nobody — the pilot flies all month and the VA sees an empty map;
 *   * no fixed width, so pilot "7" and pilot "007" are two rows on the roster
 *     and one voice on frequency.
 *
 * And nothing anywhere asked whether the number was already taken. Two pilots
 * could pick 001 on the same afternoon, both be accepted, and find out on the
 * map. A callsign is an identity — the roster, the PIREP matcher and ATC all
 * use it as one — so it has to be unique before it is issued, not after.
 *
 * WHAT A CONFLICT IS
 * ------------------
 * Not string equality. Rosters are full of callsigns issued by the old code
 * ("AEROMEXICO001") and typed by hand over the years ("Aeromexico 1"), and all
 * three of those are the same pilot number on frequency. So two callsigns clash
 * when they reduce to the same AIRLINE and the same NUMERIC VALUE, ignoring
 * spacing, zero-padding and the tag. That is the comparison `same` makes, and
 * it is deliberately looser than the string: refusing a number that is only
 * arguably taken is cheap, and issuing one twice is not.
 *
 * RESERVED NUMBERS
 * ----------------
 * Low numbers are a VA's to hand out — 001 is the founder, not whoever filled
 * in the form first. Numbers at or below `callsignReservedMax` (default 10) are
 * refused on the public join form and can only be set by staff, who reach the
 * roster through a capability check. There is no allow-list to maintain: being
 * given one BY staff is what being selected means.
 *
 * MASK PARSING
 * ------------
 * `parseMask` reads the same two halves out of a mask that `vaCallsignParts` in
 * server.js does, and must agree with it — that function is what the live
 * matcher uses, and a base or tag read differently here would issue pilots
 * callsigns their own VA does not match. It is duplicated rather than shared
 * because vaCallsignParts sits in the middle of server.js's matching code,
 * which is lifted out of source and evaluated standalone by
 * scratchpad/test-va-callsign-tags.js. scratchpad/test-crew-callsign.js pins
 * the two together instead, so drift fails a test rather than a VA.
 *
 * The one thing parseMask reads that vaCallsignParts does not is the WIDTH: how
 * many "#" the mask carries, which is how many digits a pilot number is padded
 * to. A mask with no placeholders ("OCEAN", "OCEAN VA") has no width to read,
 * so it gets DEFAULT_DIGITS.
 */

// A mask with no "#" in it says nothing about width, so pad to three: it is
// what nearly every VA uses, and what a flight number looks like.
const DEFAULT_DIGITS = 3;
const MIN_DIGITS = 1;
const MAX_DIGITS = 5;

// Numbers at or below this are staff-issue only. A VA can move the line (or
// switch it off with 0); every VA that has never thought about it gets 1–10.
const DEFAULT_RESERVED_MAX = 10;
const MAX_RESERVED_MAX = 999;

// The widest pilot number anyone may hold, so a "number" cannot be a paragraph.
const MAX_NUMBER = 99999;

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/**
 * Split a registered mask into the airline, the tag its pilots append, and the
 * width of the number between them.
 *
 *   "AEROMEXICO ###MX" -> { base: "AEROMEXICO", tag: "MX", digits: 3 }
 *   "OCEAN ##VA"       -> { base: "OCEAN",      tag: "VA", digits: 2 }
 *   "BAW ###"          -> { base: "BAW",        tag: "",   digits: 3 }
 *   "OCEAN VA"         -> { base: "OCEAN",      tag: "VA", digits: 3 }
 *   "OCEAN"            -> { base: "OCEAN",      tag: "VA", digits: 3 }
 *
 * The last line is not a guess: every display path in the product renders a
 * stored "OCEAN" as "OCEAN ##VA", so "VA" is the tag that VA was shown. A mask
 * that spells out "###" with nothing after it, on the other hand, has said it
 * has no tag, and keeps it.
 */
function parseMask(raw) {
    const s = upper(raw).replace(/\s+/g, ' ');
    if (!s) return null;
    const first = s.indexOf('#');
    if (first !== -1) {
        const base = s.slice(0, first).trim();
        if (!base) return null;
        const last = s.lastIndexOf('#');
        const hashes = s.slice(first, last + 1).replace(/[^#]/g, '').length;
        return {
            base,
            tag: s.slice(last + 1).trim(),
            digits: clampDigits(hashes),
        };
    }
    // No placeholder: a bare airline, or one with the tag already glued on.
    const m = s.match(/^(.*?)\s+VA$/);
    if (m && m[1].trim()) return { base: m[1].trim(), tag: 'VA', digits: DEFAULT_DIGITS };
    return { base: s, tag: 'VA', digits: DEFAULT_DIGITS };
}

function clampDigits(n) {
    const d = Math.trunc(Number(n) || 0);
    if (!d) return DEFAULT_DIGITS;
    return Math.max(MIN_DIGITS, Math.min(MAX_DIGITS, d));
}

// Sanitise a VA's reserved-range setting. 0 switches reservation off; anything
// unreadable falls back to the default rather than to "no reservation", because
// a VA that has never set the field has not asked for its low numbers to be up
// for grabs.
function reservedMaxFrom(raw, fallback = DEFAULT_RESERVED_MAX) {
    if (raw === '' || raw == null) return fallback;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(MAX_RESERVED_MAX, n);
}

/**
 * Every callsign shape a VA issues, richest source first.
 *
 * `callsigns` is the multi-value list (a parent brand plus its sub-fleets);
 * `callsign` is the legacy single value; `callsignPrefix` is the recruitment
 * setting, which names the AIRLINE only and so cannot carry a tag or a width of
 * its own — it is applied over the primary mask's, not instead of it. A VA with
 * none of the three gets an empty list and the join form falls back to letting
 * the applicant type the airline, which is what it did before any of this.
 */
function formatsFor(va) {
    const list = [];
    const seen = new Set();
    const masks = (Array.isArray(va && va.callsigns) && va.callsigns.length)
        ? va.callsigns
        : ((va && va.callsign) ? [va.callsign] : []);
    for (const mask of masks) {
        const f = parseMask(mask);
        if (!f || seen.has(f.base)) continue;
        seen.add(f.base);
        list.push(f);
    }
    const prefix = upper(va && va.callsignPrefix);
    if (prefix) {
        // A prefix that names an airline the VA also registered is that mask,
        // not a fourth shape — otherwise setting the prefix to your own callsign
        // would quietly strip the tag back off.
        const known = list.find((f) => f.base === parseMask(prefix).base);
        if (known) {
            // Make the configured airline the primary one.
            list.splice(list.indexOf(known), 1);
            list.unshift(known);
        } else {
            const primary = list[0];
            list.unshift({
                base: parseMask(prefix).base,
                tag: primary ? primary.tag : 'VA',
                digits: primary ? primary.digits : DEFAULT_DIGITS,
            });
        }
    }
    return list;
}

// The shape a pilot gets unless they pick another of the VA's airlines.
function primaryFormat(va) {
    return formatsFor(va)[0] || null;
}

// Read a VA's reserved line off the record.
function reservedMaxOf(va) {
    return reservedMaxFrom(va && va.callsignReservedMax);
}

/**
 * Render a pilot's callsign in the VA's shape: "AEROMEXICO 001MX".
 *
 * The number is padded to the mask's width but never truncated — a VA on a
 * two-digit mask that has grown past 99 keeps issuing callsigns rather than
 * handing out a second "42".
 */
function build(fmt, number) {
    if (!fmt || !fmt.base) return '';
    const n = numberValue(number);
    if (n == null) return fmt.base;
    const digits = String(n).padStart(clampDigits(fmt.digits), '0');
    return `${fmt.base} ${digits}${fmt.tag || ''}`.trim();
}

// What the VA's shape looks like filled in, for a form's placeholder.
function sample(fmt) {
    return build(fmt, 1);
}

// The numeric value of a pilot number, or null if there isn't one. Leading
// zeros are not significant: "007" and "7" are one number.
function numberValue(raw) {
    const digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_NUMBER) return null;
    return n;
}

/**
 * Pull the airline and the number back out of a callsign that is already
 * stored, in whatever shape the code of the day wrote it:
 *
 *   "AEROMEXICO 001MX" -> { base: "AEROMEXICO", n: 1 }
 *   "AEROMEXICO001"    -> { base: "AEROMEXICO", n: 1 }   <- issued by the old code
 *   "Aeromexico 1"     -> { base: "AEROMEXICO", n: 1 }   <- typed by hand
 *   "OPS"              -> { base: "OPS",        n: null }
 *
 * The tag is read but not returned: it is exactly the part two spellings of the
 * same pilot number disagree about, so the conflict check must not look at it.
 */
function split(raw) {
    const s = upper(raw);
    if (!s) return null;
    // Lazy airline, then the trailing number and at most a short tag. Anchored
    // at the end so a digit inside the airline's own name is not mistaken for
    // the pilot number.
    const m = s.match(/^(.*?)[\s\-_/]*(\d+)\s*([A-Z]{0,4})$/);
    if (!m || !m[1].trim()) return { base: compact(s), n: null };
    return { base: compact(m[1]), n: numberValue(m[2]) };
}

// Uppercased with every separator removed, so two spellings of one airline line
// up: "Air Canada" and "AIRCANADA" are the same base.
const compact = (raw) => upper(raw).replace(/[\s\-_/#]+/g, '');

/**
 * Do these two callsigns name the same pilot slot?
 *
 * Same airline, same number — spacing, padding and tag ignored, for the reason
 * in the header: the roster is full of callsigns written by three different
 * generations of this code and they all have to collide. Callsigns with no
 * number in them fall back to comparing the whole thing, so two pilots cannot
 * both be "OPS" either.
 */
function same(a, b) {
    const x = split(a);
    const y = split(b);
    if (!x || !y) return false;
    if (x.n == null || y.n == null) return compact(a) === compact(b) && !!compact(a);
    return x.base === y.base && x.n === y.n;
}

/**
 * The first holder of this callsign in `holders`, or null. `holders` is a list
 * of { callsign, ... }; `exceptId` skips one row so staff editing a pilot do not
 * collide with that pilot's own current callsign.
 */
function heldBy(holders, callsign, { exceptId = null, idKey = '_id' } = {}) {
    if (!callsign) return null;
    for (const h of (Array.isArray(holders) ? holders : [])) {
        if (!h) continue;
        if (exceptId != null && String(h[idKey] == null ? h.id : h[idKey]) === String(exceptId)) continue;
        if (same(h.callsign, callsign)) return h;
    }
    return null;
}

// Is this number one the VA keeps back for staff to hand out?
function isReserved(number, reservedMax) {
    const n = numberValue(number);
    const max = reservedMaxFrom(reservedMax);
    return n != null && max > 0 && n <= max;
}

/**
 * Check a number a pilot picked against the VA's shape and rules, and return
 * the callsign it becomes.
 *
 * `staff` is true on the paths behind a roster.manage capability check. That is
 * the whole of the reserved-number rule: staff may issue one, the join form may
 * not.
 */
function validate(fmt, number, { reservedMax = DEFAULT_RESERVED_MAX, staff = false } = {}) {
    if (!fmt || !fmt.base) {
        return { ok: false, code: 'no_airline', error: 'This VA has not set a callsign yet — ask its staff to add one.' };
    }
    const n = numberValue(number);
    if (n == null) {
        return { ok: false, code: 'bad_number', error: 'Pick a callsign number between 1 and ' + MAX_NUMBER + '.' };
    }
    if (!staff && isReserved(n, reservedMax)) {
        const max = reservedMaxFrom(reservedMax);
        return {
            ok: false,
            code: 'reserved',
            error: `Callsign numbers 1–${max} are reserved for senior crew. Pick ${max + 1} or above — staff can assign you a reserved number later.`,
        };
    }
    return { ok: true, n, callsign: build(fmt, n) };
}

module.exports = {
    DEFAULT_DIGITS,
    DEFAULT_RESERVED_MAX,
    MAX_NUMBER,
    parseMask,
    reservedMaxFrom,
    reservedMaxOf,
    formatsFor,
    primaryFormat,
    build,
    sample,
    numberValue,
    split,
    compact,
    same,
    heldBy,
    isReserved,
    validate,
};
