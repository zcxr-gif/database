'use strict';

/*
 * crewHero.js
 * What the top of a pilot's crew centre is, and who decides it.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The hero — the band across the top of the pilot home, with the airline's
 * photograph behind it — was the one screen in the crew centre with no
 * settings at all. Every VA got the same one: a 400px banner, a greeting, a
 * rail of badges and two buttons, in that order, forever.
 *
 * That is wrong in both directions at once. A 2,000-pilot airline with a
 * photographer on the staff wants the picture as big as it will go and nothing
 * over it; a VA of nine people flying out of one field wants their crest, their
 * name and a short band, because a 400px photograph of somebody else's A350 is
 * not their airline. Neither of them could have it.
 *
 * So: seven decisions, all of them small, none of them able to produce a broken
 * page. They are stored on the VA record beside the layout, the accent and the
 * rank ladder — the same class of thing, read by the crew centre BEFORE it has
 * a session, and for the same reason. The hero is the first paint; a setting it
 * has to wait for a login to read is a hero that draws twice.
 *
 * THE RULE EVERY FIELD FOLLOWS
 * ----------------------------
 * The default is what the hero does today. A VA that never opens this screen —
 * which is nearly all of them, nearly all of the time — gets exactly the page
 * they had before this file existed. Nothing here starts anything.
 *
 * AND NOTHING HERE CAN EMPTY THE HERO. `backdrop:'none'`, no brand, no crest,
 * no rail and no buttons is a legal combination of seven legal values and it is
 * a blank band with a name in it. That is a VA's decision to make and it is not
 * a bug — but it is a bug if they arrive at it by accident, which is why the
 * back office draws a live preview rather than seven switches and a Save.
 */

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const one = (v, allowed, fallback) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return allowed.includes(s) ? s : fallback;
};
const bool = (v, fallback) => (v === undefined || v === null ? fallback : !!v);

/** What sits behind the words. */
const BACKDROPS = [
    'banner',   // the VA's own hero image, and the drawn accent field if they have none
    'accent',   // the accent field, always — for a VA whose banner is a logo on white
    'map',      // their live traffic, moving
    'none',     // flat surface: the hero is the words and nothing else
];

/** How tall the band is. Named rather than numbered: a VA typing 900 is a VA
 *  whose pilots scroll past their own numbers to reach the page. */
const HEIGHTS = ['short', 'standard', 'tall'];

/** Where the greeting sits in the band. */
const ALIGNS = ['left', 'center'];

/** What the two buttons are. `both` is what the hero has always had. */
const ACTIONS = ['both', 'pirep', 'book', 'none'];

/**
 * The hero's settings, bounded.
 *
 * Every default below is the hero as it shipped. See the note at the top: a VA
 * who has never opened this screen must not be able to tell that it exists.
 */
function normalize(cfg) {
    const c = cfg || {};
    return {
        backdrop: one(c.backdrop, BACKDROPS, 'banner'),
        height: one(c.height, HEIGHTS, 'standard'),
        align: one(c.align, ALIGNS, 'left'),
        // The airline's mark and name, top-left of its own hero.
        brand: bool(c.brand, true),
        // The pilot's rank and club as emblems, top-right. The other half of
        // the sentence the brand block starts: whose airline this is, and who
        // this pilot is in it.
        crest: bool(c.crest, true),
        // The rail of everything else they have earned and claimed.
        badges: bool(c.badges, true),
        actions: one(c.actions, ACTIONS, 'both'),
        // A line of the VA's own under the pilot's name, in place of the one
        // the server writes from their hours. Empty means "keep ours", which
        // is the default and the right answer for almost everybody: ours says
        // something true about that pilot and a fixed line cannot.
        line: str(c.line, 120),
        // How dark the gradient over the picture is, as a percentage. A
        // photograph of a bright apron needs more of it than a night shot, and
        // this is the difference between white text that reads and white text
        // that is a rumour. Bounded well short of both ends: 0 is unreadable
        // over most photographs and 100 is a black rectangle with no picture.
        dim: (() => {
            // `|| 55` would have been wrong here in the one case somebody is
            // most likely to try: 0 is falsy, so "as light as it goes" would
            // have come back as the default rather than as the floor. A number
            // that is not a number is what falls back; a number that is one is
            // clamped.
            const n = Math.round(Number(c.dim));
            return Number.isFinite(n) ? Math.max(10, Math.min(90, n)) : 55;
        })(),
    };
}

/**
 * The VA record's hero field, in the shape everything else reads.
 *
 * The record stores it flat, like the shop's settings and for the same reason:
 * a nested object on a Mongoose document is a thing that has to be marked
 * modified, and a field nobody remembers to mark is a setting that silently
 * does not save.
 */
const fromRecord = (rec) => normalize(rec || {});

/**
 * A patch from the back office, merged over what is saved.
 *
 * A merge rather than a replace, exactly as the shop's settings are: the panel
 * saves one switch at a time as it is flipped, and a replace would have
 * "turn the crest off" reset the backdrop, the height and the VA's own line.
 */
function toRecord(patch, current) {
    return normalize({ ...fromRecord(current), ...(patch || {}) });
}

/** What a page needs to draw it. The whole of it — there is nothing secret in
 *  a hero, and it is read before anybody has signed in. */
const publicHero = (rec) => fromRecord(rec);

module.exports = {
    BACKDROPS, HEIGHTS, ALIGNS, ACTIONS,
    normalize, fromRecord, toRecord, publicHero,
};
