'use strict';

/*
 * vaSiteTemplates.js
 * The designs a virtual airline picks from, and the parts they are built out of.
 *
 * WHY A CATALOGUE AND NOT ONE STARTER
 * -----------------------------------
 * The first version of hosting laid out a single starter page. That is enough
 * to prove the plumbing and not enough to be used: a VA opening the editor to
 * one fixed design either takes it as-is — so every hosted airline looks the
 * same, which is the opposite of the point — or throws it away and is back to a
 * blank file. What a VA actually wants is the thing every site builder sells:
 * pick a look, see your own airline in it, then change the words.
 *
 * THE ONE INVARIANT ACROSS ALL SIX
 * --------------------------------
 * Every template is a different design and NONE of them is a different data
 * wiring. The 'data-crew-*' markup that pulls an airline's real figures out of
 * its crew centre is written ONCE, in BLOCKS below, and every template composes
 * the same blocks. That is the whole reason this file is arranged this way.
 *
 * If each template carried its own copy of the markup, then the day
 * 'data-crew-stat' gains a field or 'activity' changes shape, five of the six
 * would quietly stop showing a number and nobody would find out until a VA
 * asked why their pilot count was missing. The variety belongs in the CSS,
 * where being wrong is visible; the wiring belongs in one place, where being
 * wrong is not.
 *
 * WHAT MAKES A TEMPLATE DIFFERENT
 * -------------------------------
 *   tokens   the colour and type variables, written to theme.css — the file the
 *            theme picker rewrites, and the only file a VA edits to recolour a
 *            whole site
 *   css      the personality: layout, density, rules, how a heading sits
 *   pages    which blocks, in what order, on which pages
 *   thumb    a small SVG of its own layout in its own colours, for the picker.
 *            Drawn rather than screenshotted so it cannot go stale, costs no
 *            binary, and works in both themes
 *
 * A template is NOT a colour swap. Concourse is a departure board and Terminal
 * is a page of rules and monospace; swapping their accents leaves two designs
 * that are still nothing like each other. That is the bar for adding a seventh.
 */

/* ===========================================================================
 * TYPE
 *
 * Four pairings, offered to every template. Google Fonts is the only external
 * stylesheet a hosted site may load (see the CSP in vaSites.js), so these are
 * the families a VA can reach without hosting a font file themselves — and
 * every stack ends in a real system fallback, because a page that waits on a
 * font it cannot fetch is a page of invisible text.
 * ======================================================================== */
const FONTS = {
    grotesk: {
        label: 'Grotesk',
        note: 'Neutral and modern. The safe one.',
        google: 'Space+Grotesk:wght@400;500;700&family=Inter:wght@400;500;600',
        display: "'Space Grotesk', 'Inter', system-ui, sans-serif",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace",
    },
    editorial: {
        label: 'Editorial',
        note: 'A serif headline over a plain body. Reads like an airline that has been around.',
        google: 'Fraunces:opsz,wght@9..144,400;9..144,700&family=Inter:wght@400;500;600',
        display: "'Fraunces', 'Iowan Old Style', Georgia, serif",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, 'SF Mono', Menlo, monospace",
    },
    technical: {
        label: 'Technical',
        note: 'Monospace throughout. Flight-deck rather than brochure.',
        google: 'JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600',
        display: "'JetBrains Mono', ui-monospace, monospace",
        body: "'Inter', system-ui, -apple-system, sans-serif",
        mono: "'JetBrains Mono', ui-monospace, monospace",
    },
    humanist: {
        label: 'Humanist',
        note: 'Warm and rounded. Good for a smaller crew.',
        google: 'Outfit:wght@400;500;700&family=Karla:wght@400;500;700',
        display: "'Outfit', system-ui, sans-serif",
        body: "'Karla', system-ui, -apple-system, sans-serif",
        mono: "ui-monospace, Menlo, monospace",
    },
};

const MODES = {
    light: { label: 'Light' },
    dark: { label: 'Dark' },
    auto: { label: 'Follow the visitor', note: 'Light or dark, whichever their device is set to.' },
};

/* ===========================================================================
 * MOTION
 *
 * How much the site moves, as ONE choice rather than as a row of switches.
 *
 * WHY IT IS A THEME FIELD AND NOT A TEMPLATE DETAIL
 * -------------------------------------------------
 * Movement is taste in exactly the way colour is. Two airlines can pick the
 * same design and want opposite things from it: a cargo VA wants a page that
 * sits still and loads, and a 200-pilot flag carrier wants the thing to feel
 * like a title sequence. Baking one answer into each design forces a VA to
 * abandon a layout they like over a preference that has nothing to do with
 * layout — which is the same complaint the accent picker exists to answer.
 *
 * WHY ONE CHOICE AND NOT SIX SLIDERS
 * ----------------------------------
 * Duration, distance, easing, stagger and scale are not independent. A long
 * travel at a short duration is a twitch; a spring easing at 1.1s is a wobble.
 * Offered separately they combine into far more wrong answers than right ones,
 * and the VA who most wants to change this is the one least equipped to pick
 * five numbers that agree. So a preset sets all of them together, and every
 * preset is a combination somebody checked.
 *
 * WHAT A PRESET ACTUALLY IS
 * -------------------------
 *   tokens   custom properties written into theme.css. Every animated rule in
 *            the base stylesheet reads through these, so changing the preset
 *            is a rewrite of one small file and nothing else.
 *   count    whether the live figures count UP to their value rather than
 *            appearing at it. It is a flag and not a token because it is the
 *            one piece of motion that is script rather than stylesheet.
 *
 * AND THE ONE THING THAT IS NOT A CHOICE
 * --------------------------------------
 * prefers-reduced-motion wins over every preset, including Cinematic. A visitor
 * who has told their operating system that movement makes them ill is not
 * overruled by a dropdown in somebody else's editor. That is enforced at the
 * top of BASE_CSS for the stylesheet and again in site.js for the script.
 * ======================================================================== */
const MOTION = {
    none: {
        label: 'Still',
        note: 'Nothing moves. The fastest answer, and the right one for a page that is mostly words.',
        count: false,
        tokens: {
            in: '0s', ease: 'linear', rise: '0px', scale: '1',
            blur: '0px', stagger: '0ms', hover: '0px',
        },
    },
    subtle: {
        label: 'Subtle',
        note: 'A short fade as each section arrives. Noticed once, then forgotten.',
        count: false,
        tokens: {
            in: '.42s', ease: 'cubic-bezier(.32, .72, 0, 1)', rise: '6px', scale: '1',
            blur: '0px', stagger: '0ms', hover: '1px',
        },
    },
    standard: {
        label: 'Standard',
        note: 'Sections rise into place, lists arrive a row at a time, and the figures count up.',
        count: true,
        tokens: {
            in: '.55s', ease: 'cubic-bezier(.32, .72, 0, 1)', rise: '14px', scale: '1',
            blur: '0px', stagger: '55ms', hover: '2px',
        },
    },
    expressive: {
        label: 'Expressive',
        note: 'Further to travel and a spring at the end. For an airline with something to say.',
        count: true,
        // The overshoot in this curve is what "spring" means here — it passes
        // its resting place and comes back. Paired with a start slightly SMALL,
        // so the settle reads as the section arriving rather than as a bounce.
        tokens: {
            in: '.72s', ease: 'cubic-bezier(.22, 1.2, .36, 1)', rise: '26px', scale: '.97',
            blur: '0px', stagger: '80ms', hover: '3px',
        },
    },
    cinematic: {
        label: 'Cinematic',
        note: 'Slow, long and softened, like a title sequence. Best on a design built around photographs.',
        count: true,
        // Starting LARGER and settling is a camera pushing in; starting smaller
        // is a thing being placed on a table. The first is what a photographic
        // site wants, so this is the one preset whose scale is above 1.
        tokens: {
            in: '1.05s', ease: 'cubic-bezier(.16, 1, .3, 1)', rise: '30px', scale: '1.025',
            blur: '6px', stagger: '105ms', hover: '3px',
        },
    },
};

const DEFAULT_MOTION = 'standard';

/* ===========================================================================
 * PATTERN
 *
 * The half of a brand that a colour picker cannot reach.
 *
 * Two airlines can both pick navy and still be nothing alike, because what
 * separates them is not the hue — it is the marks. A tail fin, a cheatline, a
 * woven motif on the seat fabric. A hosted site with no way to express that
 * ends up as somebody else's layout with the airline's colour poured into it,
 * which is exactly the complaint every template system eventually gets.
 *
 * So a VA picks a MOTIF as well as an accent, and it is theirs across the whole
 * site: behind the hero, across the apply band, along the footer.
 *
 * THREE RULES, AND THE REASON FOR EACH
 *
 * 1. DRAWN IN CSS, NEVER FETCHED. A motif is gradients, so it costs no request,
 *    cannot 404, scales to any display without a second asset, and is still
 *    there on the render before the network answers. An uploaded tile would
 *    fail all four, and a hosted site cannot store binaries anyway.
 *
 * 2. currentColor, NEVER A FIXED INK. The same motif runs behind dark text on
 *    the page background AND behind light text on a block of the accent. A
 *    hard-coded ink is invisible on one of the two, which is how a pattern
 *    system quietly turns into a light-mode-only pattern system. Mixing from
 *    currentColor means the motif is always the section's own text colour at a
 *    whisper, so it is always visible and never loud.
 *
 * 3. A WHISPER. Every mix here is under 15%. A motif is meant to be noticed on
 *    the second look, not the first — a page that reads as wallpaper is a page
 *    where nobody read the words.
 *
 * `none` is first and is a real answer, not an absence: plenty of airlines are
 * a wordmark and white space, and the picker should not imply otherwise.
 * ======================================================================== */

// The mix is written once. `color-mix` against currentColor is what makes one
// declaration work on the page and on a block of the accent; the @supports
// fallback in BASE_CSS drops the whole motif layer where it is unavailable,
// because a motif is decoration and a wrong one is worse than none.
const M = 'color-mix(in srgb, currentColor 11%, transparent)';
const MS = 'color-mix(in srgb, currentColor 14%, transparent)';

const PATTERNS = {
    none: {
        label: 'None',
        note: 'A wordmark and white space. Plenty of airlines are exactly this.',
        image: 'none',
        size: 'auto',
    },
    stripe: {
        label: 'Cheatline',
        note: 'Fine diagonal rules, like the stripe down a fuselage.',
        image: `repeating-linear-gradient(135deg, ${M} 0 2px, transparent 2px 11px)`,
        size: 'auto',
    },
    chevron: {
        label: 'Chevron',
        note: 'A zigzag. Reads as movement without saying anything about direction.',
        image: [
            `linear-gradient(135deg, ${M} 25%, transparent 25%)`,
            `linear-gradient(225deg, ${M} 25%, transparent 25%)`,
            `linear-gradient(315deg, ${M} 25%, transparent 25%)`,
            `linear-gradient(45deg, ${M} 25%, transparent 25%)`,
        ].join(', '),
        size: '26px 26px',
        position: '-13px 0, -13px 0, 0 0, 0 0',
    },
    grid: {
        label: 'Grid',
        note: 'A drawing sheet. Technical, quiet, hard to get wrong.',
        image: `linear-gradient(${M} 1px, transparent 1px), linear-gradient(90deg, ${M} 1px, transparent 1px)`,
        size: '30px 30px',
    },
    dots: {
        label: 'Dots',
        note: 'An even field of points. The softest of these.',
        image: `radial-gradient(${MS} 1.4px, transparent 1.5px)`,
        size: '18px 18px',
    },
    diamond: {
        label: 'Lattice',
        note: 'Crossed diagonals. Woven rather than printed.',
        image: `repeating-linear-gradient(45deg, ${M} 0 1px, transparent 1px 15px), repeating-linear-gradient(-45deg, ${M} 0 1px, transparent 1px 15px)`,
        size: 'auto',
    },
    wave: {
        label: 'Wave',
        note: 'Interlocking arcs. Warm, and not straight-edged like the rest.',
        image: [
            `radial-gradient(circle at 50% 116%, transparent 10px, ${M} 10px 11px, transparent 11px)`,
            `radial-gradient(circle at 50% -16%, transparent 10px, ${M} 10px 11px, transparent 11px)`,
        ].join(', '),
        size: '26px 13px',
        position: '0 0, 13px 6.5px',
    },
    weave: {
        label: 'Weave',
        note: 'A basket check, like cabin fabric seen close up.',
        image: [
            `linear-gradient(45deg, ${M} 25%, transparent 25% 75%, ${M} 75%)`,
            `linear-gradient(45deg, ${M} 25%, transparent 25% 75%, ${M} 75%)`,
        ].join(', '),
        size: '18px 18px',
        position: '0 0, 9px 9px',
    },

    /* The three below are about aviation rather than about decoration. A VA
     * picking a motif is answering "what is my airline", and "a grid" is a
     * weaker answer than "the marks on a runway threshold" — so the shelf
     * carries a few that could not belong to a plumbing company.
     *
     * All three are still one gradient declaration each, still mixed from
     * currentColor, and still under 15%: the rules at the top of this block do
     * not bend for a better idea. */
    contrail: {
        label: 'Contrails',
        note: 'Paired hairlines drawn high and wide apart, like vapour across a sky.',
        // A PAIR of lines rather than one, and a long way apart. That is what
        // separates it from Cheatline, which is a single rule repeated tightly:
        // one reads as a stripe painted on metal, this reads as something a long
        // way off having gone past.
        image: `repeating-linear-gradient(108deg, transparent 0 17px, ${M} 17px 18px, transparent 18px 22px, ${M} 22px 23px, transparent 23px 56px)`,
        size: 'auto',
    },
    radar: {
        label: 'Radar',
        note: 'Range rings sweeping out from the corner. Quiet, and unmistakably a screen.',
        image: `repeating-radial-gradient(circle at 0% 100%, transparent 0 26px, ${M} 26px 27px, transparent 27px 54px)`,
        size: 'auto',
    },
    threshold: {
        label: 'Threshold',
        note: 'The piano keys at the end of a runway. The most literal of these, on purpose.',
        /* The lighter mix and the wider gap, not the 14% one every other broad
           pattern here uses. A bar is a solid field of ink where a hairline is
           a line through one, so the same percentage that whispers as a rule
           SHOUTS as a stripe — behind a hero it stopped being a motif and
           started being a background the headline sat on top of. */
        image: `repeating-linear-gradient(90deg, ${M} 0 4px, transparent 4px 17px)`,
        size: 'auto',
    },
};

const DEFAULT_PATTERN = 'none';

const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A hex colour, or null. Never trust one into a stylesheet unchecked: a token
 *  file is CSS, and an unvalidated value there closes a declaration and opens
 *  whatever the author fancies. */
function hex(v, fallback) {
    const s = String(v == null ? '' : v).trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
}

/* ===========================================================================
 * THE BLOCKS
 *
 * The section vocabulary. Every template composes these and no template writes
 * its own version of one, so the data wiring is in exactly one place.
 *
 * Class names are semantic and shared ('.hero', '.figures', '.rows', '.wall'),
 * which is what lets six stylesheets produce six designs over identical markup
 * — and what lets a VA lift a block out of the library and paste it into a page
 * from a different template and have it look right.
 *
 * EVERY BLOCK CARRIES ITS OWN FALLBACK. What is between the tags is what a
 * visitor sees when the crew centre is unreachable, so a block is correct
 * before any fetch resolves. That is the rule crew-feed.js is built around and
 * it has to hold in the markup, not just in the reader.
 * ======================================================================== */
/* THE PAGES THIS DESIGN HAS, as nav links.
 *
 * Built from the design's own page list rather than hard-coded, because the
 * designs no longer agree on what pages they have — Terminal has an About,
 * Skyline has a Join, and a header that named a page the design does not
 * produce is a 404 on every site using it.
 *
 * Every href is RELATIVE. The same published bytes are served at the airline's
 * own subdomain and at inflight.info/va/<slug>/, and a link rooted at "/" means
 * the platform's root at the second address. See SERVING AT A PATH in
 * vaSites.js.
 */
function navLinks(c, indent) {
    const pad = indent || '      ';
    const pages = Array.isArray(c.pages) && c.pages.length
        ? c.pages
        : [{ path: 'index.html', label: 'Home' }];
    return pages
        .map(p => `${pad}<a href="${p.path === 'index.html' ? './' : esc(p.path)}">${esc(p.label)}</a>`)
        .join('\n');
}

const BLOCKS = {

    /* THE HEADER.
     *
     * Three elements that look like two, and every one of them earns its place:
     *
     *   .bar__in    the bar can run full width so a design may paint it, while
     *               its CONTENTS line up with everything in <main>. Those are
     *               two different boxes, so there are two elements.
     *   .bar__burger  ships HIDDEN. site.js reveals it. With JavaScript off
     *               there is no button that does nothing and the links below
     *               simply wrap — a plainer header, and a working one.
     *   .bar__scrim ships hidden too, and is a <button> rather than a <div> so
     *               that tapping outside the open panel is a real, focusable,
     *               announced way to close it rather than a click handler on
     *               something with no role.
     */
    nav: (c) => `
<header class="bar" data-bar>
  <div class="bar__in">
    <a class="mark" href="./">
      <!-- The logo the VA already uploaded to their Inflight profile. The
           wrapper is [data-crew-figure] so that a VA WITHOUT one gets a
           wordmark rather than a broken-image icon: crew-feed.js removes the
           whole holder, not just the img. -->
      <span class="logo" data-crew-figure hidden><img data-crew-brand="logo" alt=""></span>
      <span data-crew-brand="name">${esc(c.name)}</span>
    </a>
    <button class="bar__burger" type="button" aria-expanded="false" aria-controls="siteNav" aria-label="Menu" hidden><i></i></button>
    <nav class="bar__nav" id="siteNav">
${navLinks(c)}
      <a href="${c.crew}">Crew centre</a>
      <a class="cta" href="${c.crew}/join">Apply</a>
    </nav>
  </div>
</header>
<button class="bar__scrim" type="button" tabindex="-1" aria-label="Close the menu" hidden></button>`,

    /* THE HERO.
     *
     * The banner sits BEHIND the words rather than above them, and is removed
     * entirely when the VA has not uploaded one — a hero with no photograph is
     * a design; a hero with a gap where one should be is a fault. The scrim in
     * style.css is not optional either: white text over an unknown photograph
     * is unreadable often enough to be a rule.
     *
     * data-motif on the section is what puts the airline's own pattern behind
     * a hero with no photograph, and style.css takes it away again when there
     * IS one — two decorations fighting over the same space is one too many.
     */
    hero: (c) => `
  <section class="hero" data-motif>
    <div class="hero__bg" data-crew-figure hidden>
      <img data-crew-brand="banner" alt="" loading="eager" decoding="async" fetchpriority="high">
    </div>
    <div class="hero__in">
      <p class="eyebrow">${esc(c.callsign || 'Virtual airline')} &middot; Infinite Flight</p>
      <h1>Fly with ${esc(c.name)}.</h1>
      <p class="lede">Write the sentence here that says what your airline is for.
         One sentence, in your own words. The numbers underneath look after themselves.</p>
      <div class="actions">
        <a class="cta" href="${c.crew}/join">Apply to fly</a>
        <a class="cta cta--ghost" href="${c.crew}">Visit the crew centre</a>
      </div>
    </div>
  </section>`,

    // A section of the VA's own words. Nothing in it is fed from anywhere —
    // that is the point of it. Every other block on this page is the crew
    // centre talking; this is the airline.
    text: () => `
  <section class="block">
    <div class="block__head"><h2>A heading you write</h2></div>
    <p class="prose">And the words under it. This section is yours — nothing
       here is filled in from the crew centre, so whatever you type stays
       exactly as you typed it.</p>
    <p class="prose">Add as many of these as you like from Insert a section, or
       just copy this block and change the words.</p>
  </section>`,

    figures: () => `
  <!-- FIGURES. Each number is written in by crew-feed.js from your crew centre.
       Type a TRUE fallback between the tags: if the feed is quiet the page keeps
       what you wrote. A figure the crew centre does not have is removed along
       with its label rather than printed as 0. -->
  <section class="figures">
    <div data-crew-figure><b data-crew-stat="pilots">&mdash;</b><span>pilots</span></div>
    <div data-crew-figure><b data-crew-stat="hours" data-crew-suffix="+">&mdash;</b><span>hours flown</span></div>
    <div data-crew-figure><b data-crew-stat="destinations">&mdash;</b><span>destinations</span></div>
    <div data-crew-figure><b data-crew-stat="routesActive">&mdash;</b><span>routes</span></div>
  </section>`,

    network: () => `
  <!-- THE NETWORK. One copy of the <template> per sector. Everything in {{ }} is
       escaped on the way in, so a note typed in the crew centre can never write
       HTML into this page. -->
  <section class="block">
    <div class="block__head"><h2>Where we fly</h2></div>
    <ul class="rows" data-crew-list="routes" data-crew-limit="12">
      <template><li><b>{{from}} &rarr; {{to}}</b> <span>{{flight}} &middot; {{ac}}</span></li></template>
      <li><b>Add your sectors</b> <span>They appear here as soon as they are in the crew centre.</span></li>
    </ul>
  </section>`,

    /* THE HUBS. Where the airline is BASED, which is a different question from
     * where it flies and the one an applicant actually asks first — nobody
     * joins an airline whose whole network is on the other side of the world
     * from the time of day they play.
     *
     * Read from the same route map as the network, so a VA that has published
     * sectors already has hubs without typing them anywhere. */
    hubs: () => `
  <section class="block" data-crew-section>
    <div class="block__head">
      <h2>Where we are based</h2>
      <p>The airports we fly the most of our sectors out of.</p>
    </div>
    <ul class="tiles" data-crew-list="hubs" data-crew-limit="8">
      <template><li class="tile"><b class="code">{{icao}}</b><span>{{routes}} routes &middot; {{departures}} departures</span></li></template>
    </ul>
  </section>`,

    activity: () => `
  <!-- WHAT WE HAVE BEEN DOING. The rows your crew centre writes by itself — a
       pilot joined, somebody was promoted, an event went up. These are the only
       lines on the page that cannot go stale. -->
  <section class="block" data-crew-section>
    <div class="block__head"><h2>Lately</h2></div>
    <ul class="rows" data-crew-list="activity" data-crew-limit="6">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,

    notices: () => `
  <!-- THE NOTICEBOARD, the written half only. Drop data-crew-written to get the
       automatic rows in here too. -->
  <section class="block" data-crew-section>
    <div class="block__head"><h2>Notices</h2></div>
    <ul class="rows" data-crew-list="notices" data-crew-written="on" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{body}}</span></li></template>
    </ul>
  </section>`,

    events: (c) => `
  <section class="block">
    <div class="block__head"><h2>Next departures</h2></div>
    <ul class="rows" data-crew-list="events" data-crew-limit="4">
      <template><li><b>{{title}}</b> <span>{{from}} &rarr; {{to}}</span></li></template>
      <li><b>Nothing on the calendar yet</b> <span>Publish an event in the crew centre.</span></li>
    </ul>
    <p class="more"><a href="${c.crew}">See the full calendar &rarr;</a></p>
  </section>`,

    wall: () => `
  <!-- THE WALL. The Instagram posts your staff hung on the crew centre. Each
       tile stays a button until it is scrolled to — nine Instagram embeds is
       several megabytes, and most visitors never reach the bottom of a page.
       site.js removes this whole section if there is no wall. -->
  <section class="block" id="wall" hidden>
    <div class="block__head"><h2>The airline, photographed</h2></div>
    <div class="wall" id="wallGrid"></div>
    <p class="more" id="wallHandle" hidden></p>
  </section>`,

    /* THE FLEET.
     *
     * A grid of cards rather than a list of rows, because an aircraft is a
     * thing you look at. Each card carries a picture, and the picture is
     * guaranteed: the VA's own livery shot if they uploaded one, and otherwise
     * a silhouette crew-feed.js DRAWS for the type — so a fleet of forty
     * airframes nobody has photographed is still a fleet page rather than a
     * grid of grey boxes.
     *
     * {{credit}} is the attribution and it is part of the template, not an
     * afterthought. Where a picture came from somebody else it says whose it is
     * and links back; where we drew it, it says that. crew-feed.js removes the
     * line when there is nothing to attribute, so a VA's own upload does not
     * get a credit invented for it.
     */
    fleet: () => `
  <section class="block">
    <div class="block__head">
      <h2>The fleet</h2>
      <p>Every aircraft and livery we operate, straight from the crew centre's fleet editor.</p>
    </div>
    <ul class="cards" data-crew-list="fleet" data-crew-limit="24">
      <template>
        <li class="card">
          <span class="card__media"><img src="{{image}}" data-fit="{{fit}}" data-crew-fallback="{{fallback}}" alt="{{aircraft}}" loading="lazy" decoding="async"></span>
          <span class="card__body">
            <b>{{aircraft}}</b>
            <span>{{livery}}</span>
            <span class="card__credit">{{credit}}</span>
          </span>
        </li>
      </template>
      <li class="card"><span class="card__body"><b>Add your fleet in the crew centre</b><span>Aircraft and liveries appear here as soon as they are in the fleet editor.</span></span></li>
    </ul>
  </section>`,

    about: (c) => `
  <section class="block">
    <div class="block__head"><h2>About ${esc(c.name)}</h2></div>
    <p class="prose">Say who runs the airline, how it is organised, and what it
       expects of a pilot. Two or three short paragraphs is plenty — anybody who
       wants the detail will read your operations manual.</p>
    <p class="prose">Say what a new pilot's first week looks like. That is the
       question every applicant actually has, and almost no virtual airline
       answers it on its homepage.</p>
  </section>`,

    /* WHAT THE AIRLINE IS LIKE.
     *
     * Not what it flies — what it is like to be in. This is the block a VA
     * fills in with the things that make it itself: the rule about callsigns,
     * the Sunday group flight, the fact that nobody is ever told off for a hard
     * landing. Every airline on the platform has three of these and almost none
     * of them are anywhere on their website.
     *
     * Deliberately the VA's own words, fed from nothing. There is no crew
     * centre field for a culture and there should not be one. */
    values: () => `
  <section class="block" data-motif>
    <div class="block__head">
      <h2>How we fly</h2>
      <p>The three or four things that make this airline itself. Change every word of these.</p>
    </div>
    <ul class="tiles">
      <li class="tile"><b>We fly together</b><span>A group flight every week, on the same day, whoever turns up.</span></li>
      <li class="tile"><b>Nobody is chased</b><span>Fly when you want to. There is no monthly minimum and no leaderboard.</span></li>
      <li class="tile"><b>Realistic, not strict</b><span>Real routes and real liveries. Nobody is told off for a hard landing.</span></li>
    </ul>
  </section>`,

    /* THE PEOPLE WHO RUN IT, as roles rather than names.
     *
     * Roles come from the crew centre and names deliberately do not: a staff
     * list on a public page goes out of date the week somebody steps down, and
     * it puts real people's handles on a page anybody can scrape. The
     * departments are the useful half and they are the half that stays true. */
    staff: () => `
  <section class="block" data-crew-section>
    <div class="block__head">
      <h2>Who runs the airline</h2>
      <p>The teams behind the operation. Ask for any of them in the crew centre.</p>
    </div>
    <ul class="pills" data-crew-list="roles" data-crew-limit="14">
      <template><li class="pill"><span class="dot" style="background:{{color}}"></span>{{name}}</li></template>
    </ul>
  </section>`,

    /* CODESHARES. Read off the route map, where a sector already knows whether
     * it is flown with somebody else and who. A partner list typed by hand is
     * a list that outlives the partnership. */
    partners: () => `
  <section class="block" data-crew-section>
    <div class="block__head">
      <h2>We fly with</h2>
      <p>The airlines we share sectors with.</p>
    </div>
    <ul class="pills" data-crew-list="partners" data-crew-limit="12">
      <template><li class="pill">{{name}}</li></template>
    </ul>
  </section>`,

    // THE LADDER, from the crew centre. The single most persuasive list on a
    // virtual airline's website to somebody deciding whether to apply, and the
    // one nobody remembers to update by hand. Sorted by the hours each rung
    // asks for, so it reads upward however it happens to be stored.
    ranks: () => `
  <section class="block">
    <div class="block__head"><h2>How you move up</h2></div>
    <ol class="steps" data-crew-list="ranks" data-crew-limit="10">
      <template><li><span class="badge"><img src="{{image}}" alt="" loading="lazy" decoding="async"></span><b>{{name}}</b> <span>{{from}}</span></li></template>
      <li><b>Set your rank ladder</b> <span>Add it in the crew centre and it appears here.</span></li>
    </ol>
  </section>`,

    /* WHAT HAPPENS WHEN YOU APPLY.
     *
     * The question every applicant has and the one almost no VA answers. Four
     * numbered tiles, and the numbers are drawn by CSS counters rather than
     * typed, so reordering them in the editor cannot leave a 3 above a 2. */
    joining: (c) => `
  <section class="block">
    <div class="block__head">
      <h2>What happens when you apply</h2>
      <p>Say what it really looks like. Every one of these is yours to change.</p>
    </div>
    <ul class="tiles tiles--numbered">
      <li class="tile"><b>You send the form</b><span>A few minutes, in the crew centre. No essay.</span></li>
      <li class="tile"><b>A person reads it</b><span>Usually within a day or two. You get a real answer either way.</span></li>
      <li class="tile"><b>You get your callsign</b><span>And the crew centre account that goes with it.</span></li>
      <li class="tile"><b>You fly</b><span>Pick any sector on the schedule. Nobody minds where you start.</span></li>
    </ul>
    <p class="more"><a href="${c.crew}/join">Start an application &rarr;</a></p>
  </section>`,

    /* A QUOTE. What one of your pilots said, or what the airline believes.
     * The only place on the page where the type gets larger without being a
     * heading, which is what makes one of these worth having and two of them
     * worth nothing. */
    quote: () => `
  <section class="block">
    <figure class="quote">
      <p>&ldquo;Put something here somebody actually said. A line from a pilot
         about their first week is worth more than a paragraph you wrote about
         yourselves.&rdquo;</p>
      <figcaption class="by">A pilot, somewhere over the Atlantic</figcaption>
    </figure>
  </section>`,

    /* HOW TO REACH US. The one block whose absence people actually notice, and
     * the Discord invite comes from the crew centre so it cannot rot into a
     * dead link the week the server is remade. */
    contact: (c) => `
  <section class="block">
    <div class="block__head">
      <h2>Talk to us</h2>
      <p>Before you apply, or after. Either is fine.</p>
    </div>
    <ul class="tiles">
      <li class="tile"><b>Discord</b><span>Where the airline actually lives. <a data-crew-brand="discord" href="#">Join the server</a></span></li>
      <li class="tile"><b>The crew centre</b><span>Schedules, reports and the noticeboard. <a href="${c.crew}">Open it</a></span></li>
      <li class="tile"><b>Apply</b><span>A few minutes, and a human answer. <a href="${c.crew}/join">Start</a></span></li>
    </ul>
  </section>`,

    /* WORDS BESIDE A PICTURE. The layout every airline wants for "who we are"
     * and the one a stack of full-width sections cannot produce. Two columns on
     * a screen, one on a phone — and the picture goes first on a phone whichever
     * side it was on, so two of these stacked do not alternate. */
    split: () => `
  <section class="block">
    <div class="split">
      <div>
        <div class="block__head"><h2>Who we are</h2></div>
        <p class="prose">Two or three sentences about the airline, next to a
           picture of one of your aircraft. Anybody who wants the detail will
           read your operations manual — this is the part they read first.</p>
      </div>
      <!-- Put your own picture here. Any https:// address works; the ones you
           upload in the Website tab are already https. -->
      <div class="split__media">
        <img src="" alt="" loading="lazy" decoding="async">
      </div>
    </div>
  </section>`,

    /* A GRID OF PHOTOGRAPHS.
     *
     * A tile is a <button> when it opens the picture larger and an <a> when it
     * goes somewhere, because those are two different things to a keyboard and
     * to a screen reader. site.js turns [data-shot] into a lightbox; drop the
     * attribute and the tile is just a picture. */
    gallery: () => `
  <section class="block">
    <div class="block__head">
      <h2>The airline, photographed</h2>
      <p>Swap these for your own. Each tile opens larger when it is clicked.</p>
    </div>
    <div class="shots">
      <button class="shot" type="button" data-shot="" data-caption="On the line" aria-label="Open this picture larger">
        <img src="" alt="On the line" loading="lazy" decoding="async">
        <figcaption>On the line</figcaption>
      </button>
    </div>
  </section>`,

    cta: (c) => `
  <section class="band" data-motif>
    <h2>There is a seat for you.</h2>
    <p>Applications take a few minutes and get a human answer.</p>
    <div class="actions">
      <a class="cta" href="${c.crew}/join">Apply to fly</a>
      <a class="cta cta--ghost" href="${c.crew}">Look around first</a>
    </div>
  </section>`,

    footer: (c) => `
<footer>
  <div class="foot__in">
    <div>
      <p>${esc(c.name)} is a virtual airline on Infinite Flight. Not affiliated with any real-world carrier.</p>
      <p>Crew centre hosted by <a href="${c.crewBase}">Inflight</a>.</p>
    </div>
    <div class="foot__links">
${navLinks(c, '      ')}
      <a href="${c.crew}">Crew centre</a>
      <a href="${c.crew}/join">Apply</a>
    </div>
  </div>
</footer>`,
};

// What the editor offers under "Insert a section". `nav` and `footer` are left
// out on purpose: a page has one of each and they are already in every
// template, so offering them is offering a way to end up with two.
const INSERTABLE = [
    { id: 'hero', label: 'Hero', note: 'Headline, one sentence, and the apply button.' },
    { id: 'figures', label: 'Live figures', note: 'Pilots, hours, destinations, routes — from your crew centre.' },
    { id: 'network', label: 'Network', note: 'Your published sectors, as a list.' },
    { id: 'hubs', label: 'Hubs', note: 'The airports you fly most out of, worked out from your route map.' },
    { id: 'activity', label: 'Lately', note: 'Joins, promotions and published events, written by your crew centre.' },
    { id: 'notices', label: 'Notices', note: 'What your staff have written on the noticeboard.' },
    { id: 'events', label: 'Events', note: 'The next departures on your calendar.' },
    { id: 'wall', label: 'Instagram wall', note: 'The posts your staff chose in the crew centre.' },
    { id: 'fleet', label: 'Fleet', note: 'Your aircraft as picture cards. Every one gets an image, credited.' },
    { id: 'about', label: 'About', note: 'Two paragraphs about the airline.' },
    { id: 'values', label: 'How we fly', note: 'The three or four things that make your airline itself.' },
    { id: 'staff', label: 'Who runs it', note: 'Your crew centre roles, as a row of labels. No names.' },
    { id: 'partners', label: 'Codeshares', note: 'The airlines you share sectors with, from your route map.' },
    { id: 'ranks', label: 'Ranks', note: 'Your rank ladder, from the crew centre.' },
    { id: 'joining', label: 'What happens when you apply', note: 'Four numbered steps. The question every applicant has.' },
    { id: 'quote', label: 'A quote', note: 'One line, set large. Worth having once and nothing twice.' },
    { id: 'contact', label: 'Talk to us', note: 'Discord, the crew centre and the application, in three tiles.' },
    { id: 'split', label: 'Words beside a picture', note: 'Two columns on a screen, one on a phone.' },
    { id: 'gallery', label: 'Pictures', note: 'A grid of photographs, each opening larger when it is clicked.' },
    { id: 'text', label: 'Your own words', note: 'A heading and paragraphs. Nothing in it is fed from anywhere.' },
    { id: 'cta', label: 'Apply band', note: 'A full-width band with the apply button.' },
];

/* ===========================================================================
 * THE BASE STYLESHEET
 *
 * Reset, the shared block shapes, and nothing with a personality. Everything
 * that makes a template look like itself is in that template's own 'css', so
 * this file is the same in all six and a VA who edits it is editing plumbing
 * rather than design.
 *
 * Every colour and every family is a var() defined in theme.css. That is what
 * makes the theme picker a rewrite of one small file rather than a search and
 * replace across a site.
 * ======================================================================== */
const BASE_CSS = `/* Base — shared by every design. Colour, type, corners and the motif live in
   theme.css; this file is the shapes those variables are poured into.

   Read this top to bottom and you have read every design on the platform: what
   makes Concourse a departure board and Cabin a set of soft cards is the ~40
   lines each adds below this, not a second copy of any of it. */

*, *::before, *::after { box-sizing: border-box; }
html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
  /* The hero banner bleeds past the measure with a vw-based margin, and vw
     counts the scrollbar. Clipping swallows the couple of pixels that costs
     without making the page a scroll container the way overflow:hidden does. */
  overflow-x: clip;
  /* An in-page link lands under a pinned header without this. */
  scroll-padding-top: 5.5rem;
}
/* Anybody who has asked their system for less movement gets none of ours. */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
img, svg, video { max-width: 100%; height: auto; }
a { color: var(--accent); transition: color .15s ease, opacity .15s ease; }
/* A visible focus ring on everything reachable by keyboard. The browser's own
   is removed by enough resets that it is worth stating rather than assuming. */
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--accent); outline-offset: 3px; border-radius: var(--radius-sm);
}
h1, h2, h3 { font-family: var(--font-display); line-height: 1.15; letter-spacing: -.02em; }
h1 { font-size: clamp(2.1rem, 6vw, 3.8rem); margin: 0 0 1rem; }
h2 { font-size: clamp(1.2rem, 2.6vw, 1.6rem); margin: 0 0 1.4rem; }
h3 { font-size: 1.02rem; margin: 0 0 .4rem; }

/* ---------------------------------------------------------------------------
   THE MOTIF

   The airline's own pattern, drawn in gradients in theme.css and hung here on
   a ::before rather than on the element's own background — because the element
   usually already HAS a background (the accent, on a band) and a motif has to
   sit on top of it, at its own opacity, without either one owning the
   background property.

   currentColor is what makes one declaration correct behind dark text on the
   page and light text on the accent. Where color-mix is missing, the whole
   layer is dropped: a motif is decoration, and decoration that renders as an
   opaque block is worse than no decoration.
   ------------------------------------------------------------------------ */
[data-motif] { position: relative; isolation: isolate; }
[data-motif]::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: var(--motif-image, none);
  background-size: var(--motif-size, auto);
  background-position: var(--motif-position, 0 0);
  opacity: var(--motif-opacity, 1);
}
@supports not (background: color-mix(in srgb, currentColor 10%, transparent)) {
  [data-motif]::before { background-image: none; }
}
/* A motif behind a photograph is a motif nobody can see, competing with the
   only picture on the page. */
.hero:has(.hero__bg:not([hidden]))::before { background-image: none; }

/* ---------------------------------------------------------------------------
   HEADER

   The bar runs the full width of the window so a design can paint it. Its
   CONTENTS are held to the same box as everything in <main>: main is capped at
   --measure, centred, and THEN padded, so its text starts at (gutter + pad) —
   a bar padded by --pad alone lands short of that on any window wider than the
   measure. Hence the inner element and the subtracted measure.

   Pinned, because a site with a fleet page and a join page is a site people
   navigate, and a nav you have to scroll back up to reach is a nav that does
   not get used. --bar-bg is separate from --bg so a design that paints the
   bar (Livery) does not have to re-state the blur and the border.
   ------------------------------------------------------------------------ */
.bar {
  position: sticky; top: 0; z-index: 50;
  padding-inline: var(--pad);
  /* NOT painted here. See THE BAR'S OWN BACKGROUND below — this is the one
     rule in the file whose absence is deliberate. */
  background: none;
  transition: box-shadow .2s ease;
}

/* THE BAR'S OWN BACKGROUND, AND WHY IT IS ON A PSEUDO-ELEMENT.
 *
 * This is not a flourish. It is the fix for the menu panel being cut off, and
 * the reason is a rule of CSS that is easy to miss:
 *
 *   An element with a filter, a backdrop-filter, a transform or a perspective
 *   becomes the CONTAINING BLOCK for every position:fixed descendant it has.
 *
 * .bar__nav is a fixed, full-height panel and it lives INSIDE this header. With
 * backdrop-filter on .bar itself, "top: 0; bottom: 0" stopped meaning the
 * viewport and started meaning the header — a strip about three and a half rems
 * tall. The panel was laid out into that strip, its own overflow-y hid
 * everything past the first link, and a menu that should be full height opened
 * as a sliver with the links cut off. It looked intermittent because it tracks
 * backdrop-filter support rather than anything the visitor did.
 *
 * Moving the frosting to a ::after fixes it at the root: a pseudo-element has
 * no element children, so nothing can be trapped by it. The bar keeps its
 * blur, the panel gets the viewport back, and no markup changed.
 *
 * inset: 0 is the PADDING box, so a design's border-bottom still shows.
 */
.bar::after {
  content: ''; position: absolute; inset: 0; z-index: -1;
  background: var(--bar-bg, var(--bg));
  transition: background-color .2s ease;
}
/* Frosted only where it is supported AND where the design has not painted the
   bar something opaque. Backdrop-filter on a fully opaque background is a GPU
   layer for no visual difference. */
@supports (backdrop-filter: blur(8px)) {
  .bar::after {
    background: color-mix(in srgb, var(--bar-bg, var(--bg)) 88%, transparent);
    backdrop-filter: saturate(160%) blur(10px);
  }
}
/* site.js sets this once the page has been scrolled. A shadow that is there
   from the start reads as a floating strip; one that arrives on scroll reads
   as the page moving underneath. */
.bar[data-scrolled] { box-shadow: var(--shadow-1); }
.bar__in {
  max-width: calc(var(--measure) - 2 * var(--pad));
  margin-inline: auto;
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding-block: .85rem;
  min-height: 3.5rem;
}
.bar .mark {
  font-family: var(--font-display); font-weight: 700; text-decoration: none;
  color: var(--ink); display: inline-flex; align-items: center; gap: .6rem;
  letter-spacing: -.02em; min-width: 0;
}
.bar .mark > span:not(.logo) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The VA's uploaded logo. Capped by HEIGHT, never width: a wordmark logo is
   five times wider than a roundel, and a width cap makes one of the two
   illegible. */
.logo { display: inline-flex; flex: none; }
.logo img { height: 1.85rem; width: auto; display: block; border-radius: var(--radius-sm); }

.bar__nav { display: flex; gap: .35rem; align-items: center; }
.bar__nav a {
  text-decoration: none; font-size: .9rem; color: var(--muted);
  padding: .45rem .6rem; border-radius: var(--radius-sm);
  transition: color .15s ease, background-color .15s ease;
  white-space: nowrap;
}
.bar__nav a:hover { color: var(--ink); background: var(--surface); }
/* The page you are on, marked. site.js sets it from the address, so it is
   right on both of a site's two addresses without anything being hard-coded. */
.bar__nav a[aria-current="page"] { color: var(--ink); font-weight: 600; }
/* The Apply button, restated.
   The rule above colours every link in the bar --muted, and ".bar__nav a" is
   more specific than the ".cta" that says --on-accent — so without this the
   one button in the header renders in body-copy grey on a block of the accent.
   Both states, because the hover rule above has the same reach. */
.bar .cta { margin: 0; padding: .5rem 1rem; font-size: .85rem; color: var(--on-accent); }
.bar .cta:hover { background: var(--accent); color: var(--on-accent); }

/* THE BURGER.

   Hidden in the markup and revealed by site.js, which is the whole trick: with
   JavaScript off there is no button that does nothing, and the nav below stays
   an ordinary row of links that wraps. Progressive enhancement rather than a
   checkbox hack, because the panel also needs Escape, a scroll lock and focus
   moved into it — three things CSS cannot do and a menu is wrong without. */
.bar__burger {
  display: none; flex: none;
  width: 2.6rem; height: 2.6rem; padding: 0;
  align-items: center; justify-content: center;
  background: none; border: 1px solid var(--line); border-radius: var(--radius-sm);
  color: var(--ink); cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
  /* ABOVE THE PANEL IT OPENS.
     The panel is pinned to the right edge, which is exactly where this button
     is — so without a z-index of its own the open panel slides over the top of
     the only control that closes it, and the X you can see is a picture of a
     button rather than the button. Both numbers are inside .bar's own stacking
     context (it is sticky with a z-index), so this is above the panel's 60 and
     still below nothing else on the page. */
  position: relative; z-index: 70;
}
.bar__burger:hover { background: var(--surface); border-color: var(--accent-line); }
.bar__burger i {
  position: relative; display: block; width: 1.1rem; height: 2px;
  background: currentColor; border-radius: 2px;
  transition: transform .2s ease, background-color .2s ease;
}
.bar__burger i::before, .bar__burger i::after {
  content: ''; position: absolute; left: 0; width: 100%; height: 100%;
  background: currentColor; border-radius: 2px;
  transition: transform .2s ease, top .2s ease;
}
.bar__burger i::before { top: -6px; }
.bar__burger i::after { top: 6px; }
/* Open: the middle bar goes, the outer two cross. Animated from the same three
   elements rather than swapped for an X glyph, so there is no icon font and no
   second asset. */
.bar__burger[aria-expanded="true"] i { background: transparent; }
.bar__burger[aria-expanded="true"] i::before { top: 0; transform: rotate(45deg); }
.bar__burger[aria-expanded="true"] i::after { top: 0; transform: rotate(-45deg); }

.bar__scrim {
  position: fixed; inset: 0; z-index: 45;
  background: rgba(6, 8, 12, .5); border: 0; padding: 0;
  opacity: 0; transition: opacity .2s ease;
}
.bar__scrim[hidden] { display: none; }
.bar__scrim[data-open] { opacity: 1; }

/* THE PANEL.
 *
 * 54rem here and 54rem in site.js, and that is not a coincidence to be tidied
 * away later: the two used to be 54rem and 54.0625rem, which left a half-rem
 * band of window widths where the CSS had already given up the panel and the
 * script had not yet closed it. A window resized into that band kept the page's
 * scroll lock with no menu on screen to explain it — the site simply stopped
 * scrolling. One number, quoted in both files, is the whole fix.
 */
@media (max-width: 54rem) {
  html[data-js] .bar__burger { display: inline-flex; }
  html[data-js] .bar__nav {
    position: fixed; top: 0; right: 0; z-index: 60;
    width: min(20rem, 84vw);
    /* HEIGHT, NOT top+bottom.
       A fixed element pinned top and bottom is laid into the LARGE viewport on
       a phone — the one that assumes the browser's own toolbars have scrolled
       away. They have not, when a menu is the first thing a visitor opens, so
       the foot of the panel sat behind the toolbar and the Apply button at the
       end of it was unreachable. 100dvh is the viewport as it is right now. */
    height: 100dvh; max-height: 100dvh;
    flex-direction: column; align-items: stretch; justify-content: flex-start;
    gap: .25rem;
    /* Clear of the header WHATEVER the header turns out to be. site.js measures
       it into --bar-h; the fallback is the bar's own min-height, so a page whose
       script has not run yet is still laid out correctly. An airline with a tall
       logo or a name long enough to wrap used to get its first link tucked
       underneath the wordmark. */
    padding: calc(var(--bar-h, 3.5rem) + .75rem) 1.1rem calc(1.5rem + env(safe-area-inset-bottom, 0px));
    background: var(--bg);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-2);
    /* contain, so reaching the end of a long menu does not start scrolling the
       page underneath it. */
    overflow-y: auto; overscroll-behavior: contain;
    /* visibility, not display: a transform animates and display:none does
       not, and visibility:hidden is what takes the links out of the tab order
       while the panel is shut. */
    visibility: hidden; transform: translateX(100%);
    transition: transform .24s cubic-bezier(.32, .72, 0, 1), visibility .24s;
  }
  html[data-js] .bar__nav[data-open] { visibility: visible; transform: translateX(0); }
  html[data-js] .bar__nav a { padding: .8rem .75rem; font-size: 1rem; border-radius: var(--radius-sm); }
  html[data-js] .bar__nav .cta { margin-top: .6rem; text-align: center; padding: .85rem 1rem; font-size: .95rem; }

  /* The links arrive one after another behind the panel's own slide. Only when
     the site is set to move at all — [data-motion] is absent for Still and for
     anybody whose system asked for less movement, and then they are simply
     there. The cap is the same reasoning as the stagger everywhere else: past
     about eight items a queue stops reading as sequence and starts reading as
     lag. */
  html[data-motion] .bar__nav a {
    opacity: 0; transform: translateX(10px);
    transition: opacity .26s ease, transform .26s cubic-bezier(.32, .72, 0, 1);
  }
  html[data-motion] .bar__nav[data-open] a { opacity: 1; transform: translateX(0); }
  html[data-motion] .bar__nav[data-open] a:nth-child(1) { transition-delay: 60ms; }
  html[data-motion] .bar__nav[data-open] a:nth-child(2) { transition-delay: 95ms; }
  html[data-motion] .bar__nav[data-open] a:nth-child(3) { transition-delay: 130ms; }
  html[data-motion] .bar__nav[data-open] a:nth-child(4) { transition-delay: 165ms; }
  html[data-motion] .bar__nav[data-open] a:nth-child(5) { transition-delay: 200ms; }
  html[data-motion] .bar__nav[data-open] a:nth-child(n + 6) { transition-delay: 235ms; }

  /* The page must not scroll behind an open panel.

     AND MUST NOT MOVE WHILE IT IS SHUT OUT. Locking the scroll takes the
     scrollbar away, and a page that was 15px narrower than the window a moment
     ago is suddenly not — so the header, the headline and the hero all slide
     sideways as the menu opens and slide back as it shuts. That is the other
     half of what "the menu jumps" usually means.

     The width is MEASURED by site.js and put here, rather than reserved up
     front with scrollbar-gutter. Reserving would have been one line, and it
     costs a permanent strip of dead page down the right-hand side of every
     site on every browser that draws a classic scrollbar — a visible band,
     always, to smooth over a moment that happens when somebody opens a menu.
     Measuring costs nothing at all when the visitor's scrollbar is an overlay,
     which on a phone it always is, and is exact when it is not. */
  html[data-nav-open], html[data-nav-open] body { overflow: hidden; }
  html[data-nav-open] body { padding-right: var(--lock-gap, 0px); }
}

/* ---------------------------------------------------------------------------
   LAYOUT
   ------------------------------------------------------------------------ */
main { max-width: var(--measure); margin: 0 auto; padding: 0 var(--pad); }
.hero, .figures { padding-block: var(--gap); }
/* Blocks get a little over half, because two of them stacked contribute a
   bottom AND a top: a full --gap each puts eleven rems between two headings,
   which reads as a missing section rather than as space. */
.block { padding-block: calc(var(--gap) * .56); }
/* A heading and the line under it are one unit; separating them here means no
   block has to re-state the spacing between them. */
.block__head { margin-bottom: 1.4rem; }
.block__head h2 { margin-bottom: .35rem; }
.block__head p { margin: 0; color: var(--muted); font-size: .95rem; max-width: 56ch; }

/* ---------------------------------------------------------------------------
   HERO

   The banner sits BEHIND the words and always under a scrim. White text over an
   unknown photograph is unreadable often enough to be a rule rather than a
   taste: the VA chose the image, and nobody checked it against the text that
   would sit on it.
   ------------------------------------------------------------------------ */
.hero { position: relative; isolation: isolate; }
/* Edge to edge. A hero photograph inset to the text measure reads as a picture
   somebody dropped in the page; the same photograph running to the window reads
   as the top of a website. The margin pulls each side out to the viewport from
   whatever box the hero happens to sit in, so it works the same in a centred
   'main' and in Livery's full-width one. */
.hero__bg {
  position: absolute; inset: 0; z-index: -1; overflow: hidden;
  margin-inline: calc(50% - 50vw);
}
.hero__bg img { width: 100%; height: 100%; object-fit: cover; }
.hero__bg::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(to right, var(--bg) 0%, color-mix(in srgb, var(--bg) 82%, transparent) 45%, color-mix(in srgb, var(--bg) 40%, transparent) 100%);
}
/* color-mix is recent. Where it is missing the scrim falls back to a flat wash,
   which is less pretty and equally legible — the property that matters. */
@supports not (background: color-mix(in srgb, red 50%, transparent)) {
  .hero__bg::after { background: var(--bg); opacity: .82; }
}
.hero__in { position: relative; }
/* A hero carrying a photograph needs room the plain one does not. */
.hero:has(.hero__bg:not([hidden])) { padding-block: clamp(3.5rem, 9vw, 7rem); }
.eyebrow {
  font-family: var(--font-mono); font-size: .74rem; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted); margin: 0 0 1rem;
}
.lede { color: var(--muted); font-size: 1.12rem; max-width: 48ch; }
.prose { max-width: 62ch; color: var(--muted); }
.prose:last-child { margin-bottom: 0; }
/* Two buttons side by side without either block needing to know about the
   other — a hero with one CTA and a hero with two lay out the same way. */
.actions { display: flex; flex-wrap: wrap; gap: .7rem; align-items: center; margin-top: 1.5rem; }
.actions .cta { margin-top: 0; }

/* ---------------------------------------------------------------------------
   BUTTONS
   ------------------------------------------------------------------------ */
.cta {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  margin-top: 1.5rem; padding: .82rem 1.5rem;
  background: var(--accent); color: var(--on-accent);
  border: 1px solid transparent; border-radius: var(--radius);
  text-decoration: none; font-weight: 600; font-size: .95rem;
  line-height: 1.2; cursor: pointer;
  transition: filter .15s ease, transform .15s ease, box-shadow .15s ease;
}
/* The lift is the motion preset's, not this rule's. A site set to Still has a
   --motion-hover of 0 and its buttons brighten without moving; Expressive lifts
   them further than Standard. One property, so "how much does this site move"
   means the hovers as well as the arrivals. */
.cta:hover { filter: brightness(1.07); transform: translateY(calc(var(--motion-hover, 1px) * -1)); box-shadow: var(--shadow-1); }
.cta:active { transform: translateY(0); box-shadow: none; }
/* The second button in a pair. Same box, no fill — so the two line up exactly
   and the primary one is still obviously the primary one. */
.cta--ghost {
  background: none; color: var(--ink); border-color: var(--line);
}
.cta--ghost:hover { border-color: var(--accent); color: var(--accent); filter: none; }

/* ---------------------------------------------------------------------------
   FIGURES

   The label lives inside the same element as the number so that a figure the
   crew centre did not send takes its whole block with it.
   ------------------------------------------------------------------------ */
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 1.6rem; }
.figures > div { display: grid; gap: .15rem; min-width: 0; }
.figures b {
  font-size: clamp(1.9rem, 5vw, 3rem); line-height: 1; letter-spacing: -.04em;
  font-family: var(--font-display); font-variant-numeric: tabular-nums;
}
.figures span { color: var(--muted); font-size: .88rem; }

/* ---------------------------------------------------------------------------
   LISTS
   ------------------------------------------------------------------------ */
.rows, .steps { list-style: none; margin: 0; padding: 0; }
.rows li, .steps li {
  display: flex; flex-wrap: wrap; gap: .15rem 1rem; align-items: baseline;
  padding: .9rem 0; border-top: 1px solid var(--line);
}
.rows li:last-child, .steps li:last-child { border-bottom: 1px solid var(--line); }
.rows span, .steps span { color: var(--muted); font-size: .92rem; }
/* Rank badges and aircraft pictures, inside a row.

   crew-feed.js removes an <img> whose src never arrived, because an empty src
   is a broken-image icon. That leaves the .badge span behind, and the span is
   why the words in a list stay in one column when only SOME rows have a
   picture: an empty badge holds the same width as a full one.

   And when no row in the list has a picture at all, the column is pointless —
   :has(img) is what tells the two cases apart. A browser without :has falls
   back to a ragged left edge, which is untidy and still legible. */
.rows .badge, .steps .badge { flex: none; display: none; }
/* ONE width for the whole column, not per row. Sizing each badge to its own
   picture staggers the text again — a wide aircraft photo pushes only its own
   row across, which is the same ragged edge in a different place. The picture
   fits the column; the column does not fit the picture. */
.rows:has(img) .badge, .steps:has(img) .badge {
  display: block; width: 2.9rem; height: 1.9rem;
}
.rows .badge img, .steps .badge img {
  width: 100%; height: 100%; object-fit: contain; object-position: left center;
  border-radius: var(--radius-sm); display: block;
}
.steps { counter-reset: step; }
.steps li::before {
  counter-increment: step; content: counter(step);
  font-family: var(--font-mono); font-size: .75rem; color: var(--accent);
  min-width: 1.4rem;
}
.more { margin-top: 1.2rem; font-size: .9rem; }
.more a { text-decoration: none; font-weight: 600; }

/* ---------------------------------------------------------------------------
   CARDS

   The shape everything that has a picture uses: the fleet, the gallery, the
   staff. One grid, one card, so a design that wants rounded shadowed cards
   says it once and gets all three.

   auto-fill rather than auto-fit: a fleet of two should be two cards at the
   column width, not two cards stretched half the page wide each.
   ------------------------------------------------------------------------ */
.cards {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 1.1rem;
  grid-template-columns: repeat(auto-fill, minmax(min(16rem, 100%), 1fr));
}
.cards--wide { grid-template-columns: repeat(auto-fill, minmax(min(21rem, 100%), 1fr)); }
.card {
  display: flex; flex-direction: column; min-width: 0;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); overflow: hidden;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.card:hover {
  border-color: var(--accent-line); box-shadow: var(--shadow-1);
  transform: translateY(calc(var(--motion-hover, 1px) * -1));
}
/* THE PICTURE WELL.

   A fixed ratio, always. The pictures in a fleet come from three different
   places — a livery the VA uploaded, a photograph of the airframe, a
   silhouette we drew — at three different shapes, and a grid of cards whose
   tops do not line up looks like a bug in the grid rather than variety in the
   pictures. The ratio is the card's, not the image's. */
.card__media {
  position: relative; aspect-ratio: 16 / 10; background: var(--surface-2);
  display: block; overflow: hidden;
}
.card__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* A drawn outline is a MARK, not a photograph: it has no field of its own — the
   well's surface is its ground — and cropping it to fill would cut the wingtips
   off. So it is contained, centred, and given room to be a mark rather than a
   picture that not quite fits. crew-feed.js says which kind each one is. */
.card__media img[data-fit="contain"] { object-fit: contain; padding: 14% 12%; }
.card__body { padding: .95rem 1.05rem 1.1rem; display: flex; flex-direction: column; gap: .2rem; flex: 1; }
.card__body b { font-size: .98rem; letter-spacing: -.01em; }
.card__body span { color: var(--muted); font-size: .88rem; }
/* THE CREDIT LINE.

   Small, and never optional. A photograph of a real airframe belongs to the
   person who took it, and the licence we read those under is attribution: the
   name and a link back to the photo. It sits at the bottom of the card in
   --faint so it does not compete with the aircraft type, and it is pushed there
   by margin-top:auto so it lands on the same line in every card of a row
   whatever else is above it. */
.card__credit {
  margin-top: auto; padding-top: .55rem;
  font-size: .7rem; line-height: 1.35; color: var(--faint);
}
.card__credit a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.card__credit a:hover { color: var(--accent); }
/* A picture the airline took itself is owed no credit, and the feed leaves the
   line empty rather than inventing one. An empty line still has padding, so it
   still costs a few pixels under every card in the grid — which is a visible
   change to the whole page for the sake of the rows that have nothing to say. */
.card__credit:empty { display: none; }

/* ---------------------------------------------------------------------------
   TILES — the compact grid. Hubs, values, roles: a short label and a line under
   it, with no picture. Smaller and denser than a card on purpose, because a
   list of eight hubs as eight photo-sized cards is a page of nothing.
   ------------------------------------------------------------------------ */
.tiles {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: .8rem;
  grid-template-columns: repeat(auto-fill, minmax(min(12rem, 100%), 1fr));
}
.tile {
  min-width: 0; padding: 1rem 1.1rem;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color .15s ease, background-color .15s ease;
}
.tile:hover { border-color: var(--accent-line); }
.tile b { display: block; font-size: 1rem; letter-spacing: -.01em; }
.tile .code { font-family: var(--font-mono); font-size: 1.05rem; color: var(--accent); letter-spacing: .02em; }
.tile span { display: block; color: var(--muted); font-size: .86rem; margin-top: .2rem; }
/* A numbered tile — the join steps. The number is drawn rather than typed, so
   reordering the steps in the editor cannot leave "3" above "2". */
.tiles--numbered { counter-reset: tile; }
.tiles--numbered .tile { counter-increment: tile; }
.tiles--numbered .tile::before {
  content: counter(tile);
  display: grid; place-items: center;
  width: 1.7rem; height: 1.7rem; margin-bottom: .6rem;
  border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--accent);
  font-family: var(--font-mono); font-size: .78rem; font-weight: 700;
}

/* PILLS — a row of short labels. Partners, aircraft types, anything that is a
   list of names rather than a list of things. */
.pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
.pill {
  display: inline-flex; align-items: center; gap: .45rem;
  padding: .4rem .85rem; border-radius: var(--radius-pill);
  background: var(--surface); border: 1px solid var(--line);
  font-size: .86rem; color: var(--ink);
}
.pill img { width: 1.1rem; height: 1.1rem; object-fit: contain; border-radius: 3px; }
.pill .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--accent); flex: none; }

/* ---------------------------------------------------------------------------
   SPLIT — words beside a picture. The one layout an airline always wants for
   "who we are" and the one no stack of full-width blocks can produce.
   ------------------------------------------------------------------------ */
.split { display: grid; gap: clamp(1.5rem, 4vw, 3rem); align-items: center; }
@media (min-width: 48rem) {
  .split { grid-template-columns: 1fr 1fr; }
  .split--reverse > :first-child { order: 2; }
}
.split__media { border-radius: var(--radius-lg); overflow: hidden; background: var(--surface-2); }
.split__media img { width: 100%; display: block; aspect-ratio: 4 / 3; object-fit: cover; }

/* A QUOTE. What a pilot said, or what the airline believes. Deliberately the
   only place on the page where the type gets bigger without being a heading. */
.quote { margin: 0; padding: 0; }
.quote p {
  font-family: var(--font-display); font-size: clamp(1.25rem, 3vw, 1.75rem);
  line-height: 1.35; letter-spacing: -.02em; margin: 0 0 1rem; max-width: 34ch;
}
.quote footer, .quote .by {
  color: var(--muted); font-size: .9rem; max-width: none;
  margin: 0; padding: 0;
}

/* FAQ. <details> rather than a script: it is open-and-shut behaviour the
   browser already has, it prints correctly, and it is findable by the
   browser's own in-page search even while collapsed. */
.faq { border-top: 1px solid var(--line); }
.faq details { border-bottom: 1px solid var(--line); }
.faq summary {
  cursor: pointer; list-style: none; padding: 1rem 2rem 1rem 0; position: relative;
  font-weight: 600; font-size: .98rem;
}
.faq summary::-webkit-details-marker { display: none; }
.faq summary::after {
  content: '+'; position: absolute; right: .4rem; top: 50%; transform: translateY(-50%);
  font-family: var(--font-mono); color: var(--accent); font-size: 1.1rem;
}
.faq details[open] summary::after { content: '−'; }
.faq .prose { padding-bottom: 1.1rem; margin-top: 0; }

/* ---------------------------------------------------------------------------
   A PICTURE BEHIND A SECTION

   The thing every page builder has and the reason people reach for one: put a
   photograph behind the words.

   IT IS AN <img>, NOT A background-image. Three reasons, and the third is the
   one that decided it:

     · loading="lazy" and decoding="async" work on an element and not on a CSS
       background, so a page with four of these does not fetch four photographs
       before it paints;
     · the address goes through the same attribute escaping as every other URL
       on the page, rather than into a style attribute where a stray quote or
       bracket would end the declaration and start something else;
     · and object-position is a property of the picture, so a VA can say which
       part of a wide photograph survives on a phone.

   THE SCRIM IS NOT OPTIONAL. White text over an unknown photograph is
   unreadable often enough to be a rule rather than a taste — the VA chose the
   image, and nobody checked it against the words that would sit on it. --dim
   is how hard it is, and 0 is not offered as a value: the floor is applied
   here, not trusted from the editor.
   ------------------------------------------------------------------------ */
.has-bg { position: relative; isolation: isolate; color: var(--on-shot, #fff); }
.has-bg__layer { position: absolute; inset: 0; z-index: -1; overflow: hidden; }
.has-bg__layer img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  object-position: var(--bg-pos, 50% 50%);
}
.has-bg__layer::after {
  content: ''; position: absolute; inset: 0;
  background: rgba(8, 10, 14, var(--dim, .55));
}
/* Everything inside inherits the light ink, including the parts that normally
   take a muted or accent colour — those are tuned for the page background and
   are unreadable on a photograph. */
.has-bg h1, .has-bg h2, .has-bg h3, .has-bg p, .has-bg li, .has-bg b, .has-bg span,
.has-bg .lede, .has-bg .prose, .has-bg .eyebrow, .has-bg .more a { color: inherit; }
.has-bg .lede, .has-bg .prose, .has-bg .block__head p { opacity: .88; }
.has-bg .rows li, .has-bg .steps li { border-color: rgba(255, 255, 255, .22); }
.has-bg .tile, .has-bg .card, .has-bg .pill {
  background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .2);
}
.has-bg .cta--ghost { color: inherit; border-color: rgba(255, 255, 255, .5); }
.has-bg .cta--ghost:hover { background: rgba(255, 255, 255, .12); color: inherit; }
/* A section with a picture behind it needs room the flat one does not. */
.has-bg { padding-block: clamp(3rem, 8vw, 5.5rem); }

/* EDGE TO EDGE.
   Full bleed by pulling each side out to the viewport from whatever box the
   section happens to sit in, so it works the same in a centred main and in
   Livery's full-width one. The inner padding grows to fill the gutter so the
   text stays on the same left edge as everything above it. */
.bleed {
  margin-inline: calc(50% - 50vw);
  padding-inline: max(var(--pad), calc((100vw - var(--measure)) / 2 + var(--pad)));
  border-radius: 0;
}

/* ---------------------------------------------------------------------------
   THE PICTURE GRID

   Used by the gallery. A tile is a <button> when it opens in the lightbox and
   an <a> when it links somewhere, because those are two different things to a
   keyboard and to a screen reader — and never a div with a click handler.
   ------------------------------------------------------------------------ */
.shots {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(min(15rem, 100%), 1fr));
}
.shots--tight { grid-template-columns: repeat(auto-fill, minmax(min(10rem, 100%), 1fr)); gap: .6rem; }
/* A COLUMN, NOT A BLOCK.
   A grid stretches every tile to the tallest in its row, and a gallery where
   some pictures have captions and some do not has two heights in every row. As
   a block that leaves the odd one out with a taller picture; as a flex column
   with the caption pushed to the bottom, every picture is the same size and the
   captions line up. */
.shot {
  margin: 0; padding: 0; overflow: hidden; text-align: left;
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); color: inherit; font: inherit;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
button.shot, a.shot { cursor: pointer; text-decoration: none; width: 100%; }
.shot:hover { border-color: var(--accent-line); box-shadow: var(--shadow-1); transform: translateY(calc(var(--motion-hover, 1px) * -1)); }
/* flex: none, or the image is the thing that stretches instead of the caption. */
.shot img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; flex: none; }
.shot figcaption, .shot > span {
  display: block; margin-top: auto; padding: .6rem .75rem; font-size: .84rem; color: var(--muted);
}

/* THE LIGHTBOX.

   A <dialog>, so the browser supplies the modal behaviour that is tedious and
   easy to get wrong: the top layer, the backdrop, Escape, and returning focus
   to whatever opened it. site.js only opens and closes it.

   It is written in the markup by site.js rather than shipped in every page,
   because a site with no gallery should not carry a dialog it never opens. */
.lightbox {
  border: 0; padding: 0; background: none; max-width: 96vw; max-height: 96vh;
  color: #fff;
}
.lightbox::backdrop { background: rgba(6, 8, 12, .88); }
.lightbox img { max-width: 96vw; max-height: 84vh; width: auto; height: auto; display: block; border-radius: var(--radius); }
.lightbox figcaption { padding: .75rem .25rem 0; font-size: .9rem; text-align: center; opacity: .85; }
.lightbox__shut {
  position: absolute; top: -.25rem; right: -.25rem;
  width: 2.4rem; height: 2.4rem; border-radius: var(--radius-pill);
  border: 0; background: rgba(255, 255, 255, .16); color: #fff;
  font-size: 1.2rem; line-height: 1; cursor: pointer;
}
.lightbox__shut:hover { background: rgba(255, 255, 255, .3); }

/* ---------------------------------------------------------------------------
   THE APPLY BAND
   ------------------------------------------------------------------------ */
.band {
  background: var(--accent); color: var(--on-accent);
  padding: var(--gap) var(--pad); margin-top: var(--gap); text-align: center;
  border-radius: var(--radius-lg);
}
/* A design may put a rule under every h2 (Flightline does, in --ink). On a
   block of the accent that rule is a dark line under white text, so the border
   follows the text rather than the page. */
.band h2 { color: inherit; border-color: currentColor; }
.band p { color: inherit; opacity: .85; margin: 0 auto; max-width: 46ch; }
.band .cta { background: var(--on-accent); color: var(--accent); }
.band .cta--ghost { background: none; color: inherit; border-color: color-mix(in srgb, currentColor 45%, transparent); }
.band .actions { justify-content: center; }

/* ---------------------------------------------------------------------------
   THE INSTAGRAM WALL

   326x470 is the only size Instagram's embed lays out at and a cross-origin
   frame cannot be measured, so a tile holds that ratio and site.js scales the
   frame into it.
   ------------------------------------------------------------------------ */
.wall { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(14rem, 100%), 1fr)); }
.wall__tile {
  position: relative; overflow: hidden; padding: 0; aspect-ratio: 326 / 470;
  display: grid; place-items: center; cursor: pointer;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); color: var(--muted);
  font: inherit; font-size: .8rem;
}
.wall__tile:hover { border-color: var(--accent); }
.wall__tile iframe { position: absolute; top: 0; left: 0; width: 326px; height: 470px; border: 0; transform-origin: top left; }

/* ---------------------------------------------------------------------------
   FOOTER
   ------------------------------------------------------------------------ */
footer {
  margin-top: var(--gap);
  border-top: 1px solid var(--line);
  color: var(--muted); font-size: .85rem;
}
.foot__in {
  max-width: var(--measure); margin: 0 auto;
  padding: 2.5rem var(--pad) 3.5rem;
  display: grid; gap: 1.2rem;
}
@media (min-width: 42rem) {
  .foot__in { grid-template-columns: 1fr auto; align-items: start; }
}
footer p { margin: .3rem 0; max-width: 62ch; }
.foot__links { display: flex; flex-wrap: wrap; gap: .4rem 1.1rem; }
.foot__links a { color: var(--muted); text-decoration: none; }
.foot__links a:hover { color: var(--accent); }

/* ---------------------------------------------------------------------------
   MOTION

   Every moving thing on the page reads its distance, its duration, its easing
   and its stagger from the --motion-* properties in theme.css. Nothing below
   names a number of its own, which is what makes "how much does this site move"
   a single choice in the editor rather than a search through a stylesheet.

   THE THREE RULES THIS SECTION IS BUILT ON

   1. NOTHING IS EVER HIDDEN BY THE STYLESHEET ALONE. The hidden half of an
      arrival lives behind [data-reveal], and only site.js ever writes that
      attribute — and only onto sections that START below the fold. A page whose
      script fails to load has no hidden sections at all, because nothing was
      ever marked. That is the difference between an animation and a site that
      arrives blank.

   2. REDUCED MOTION WINS OVER THE PRESET. The blanket rule at the top of this
      file already flattens every duration to nothing; this section is wrapped
      again anyway, and site.js checks a third time before it marks anything.
      Cinematic is a preference of the airline's. Not moving is a preference of
      the visitor's, and the visitor's is not the one that gets overruled.

   3. THE ONE THING THAT RUNS WITHOUT JAVASCRIPT IS THE HERO. It is the only
      element whose arrival is not conditional on where the page is scrolled to,
      so it is a plain CSS animation and starts on the first paint. Behind
      [data-js] it would wait for the script, which means the headline would
      render, be seen, and only then fade in from nothing.
   ------------------------------------------------------------------------ */
@media (prefers-reduced-motion: no-preference) {

  /* ARRIVAL — a section, the first time it is reached.

     transform is written out as translateY(0) scale(1) rather than as the
     keyword none, and the filter as blur(0px) rather than none, because a spring easing
     interpolating out of the keyword rather than out of a matching function is
     where transitions go subtly wrong in one engine and not another. Writing
     the resting value in the same shape as the starting one costs nothing and
     removes the question. */
  html[data-js] [data-reveal] {
    opacity: 0;
    transform: translateY(var(--motion-rise, 14px)) scale(var(--motion-scale, 1));
    filter: blur(var(--motion-blur, 0px));
  }
  html[data-js] [data-reveal="in"] {
    opacity: 1;
    transform: translateY(0) scale(1);
    filter: blur(0px);
    transition:
      opacity var(--motion-in, .55s) var(--motion-ease, ease),
      transform var(--motion-in, .55s) var(--motion-ease, ease),
      filter var(--motion-in, .55s) var(--motion-ease, ease);
  }

  /* THE STAGGER — a list that arrives a row at a time.

     The whole point of a stagger is that it is not a second animation. A row
     travels the same distance on the same curve as the section it is in; the
     only thing it is given is a place in the queue. So there is one rule here
     and one custom property, and the queue position is arithmetic rather than a
     rule per row:

         delay = its index x --motion-stagger

     site.js writes the index. It caps it, because past a dozen the last row of
     a long fleet would be waiting a second and a half for its turn, and a
     visitor reading a page does not experience that as choreography.

     A preset with a stagger of 0ms — Subtle, Still — resolves this to a delay
     of nothing, and every row moves with its section. The rule does not need to
     know which preset is running. */
  html[data-js] [data-reveal] [data-reveal-item] {
    opacity: 0;
    transform: translateY(calc(var(--motion-rise, 14px) * .6));
  }
  html[data-js] [data-reveal="in"] [data-reveal-item] {
    opacity: 1;
    transform: translateY(0);
    transition:
      opacity var(--motion-in, .55s) var(--motion-ease, ease),
      transform var(--motion-in, .55s) var(--motion-ease, ease);
    transition-delay: calc(var(--i, 0) * var(--motion-stagger, 0ms));
  }

  /* THE HERO, on load. No script, no scroll, no condition — see rule 3 above.

     Five delays because a hero has an eyebrow, a headline, a sentence and a row
     of buttons, and the fifth is there for the design that adds one more. Past
     that they all share the last slot rather than queueing forever.

     The fill mode matters: it holds the first frame before the delay elapses, so
     the headline does not paint at full opacity and then drop to nothing to
     begin. A preset of Still sets --motion-in to 0s, which finishes the whole
     animation on the frame it starts — no movement, no flash, nothing to
     special-case. */
  @keyframes heroIn {
    from { opacity: 0; transform: translateY(var(--motion-rise, 14px)); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .hero__in > * {
    animation: heroIn var(--motion-in, .55s) var(--motion-ease, ease) both;
  }
  .hero__in > *:nth-child(1) { animation-delay: 0ms; }
  .hero__in > *:nth-child(2) { animation-delay: calc(var(--motion-stagger, 0ms) * 1.2); }
  .hero__in > *:nth-child(3) { animation-delay: calc(var(--motion-stagger, 0ms) * 2.4); }
  .hero__in > *:nth-child(4) { animation-delay: calc(var(--motion-stagger, 0ms) * 3.6); }
  .hero__in > *:nth-child(n + 5) { animation-delay: calc(var(--motion-stagger, 0ms) * 4.8); }

  /* THE FIGURE THAT COUNTS UP.
     site.js marks a number while it is running so a design can do something
     with it — Concourse dims the amber, Flight Deck holds the bracket lit. The
     tabular figures are the important half: a number counting up in
     proportional digits changes width on every frame and shoves the label
     beside it back and forth. */
  .figures b[data-counting] { font-variant-numeric: tabular-nums; }
}

/* ---------------------------------------------------------------------------
   PRINT. A fleet list and a rank ladder are the two things a VA prints.
   ------------------------------------------------------------------------ */
@media print {
  .bar, .band, .wall, .bar__scrim { display: none !important; }
  /* A section waiting to be scrolled to has never been scrolled to on paper.
     Printing must never hand somebody a page of blanks. */
  [data-reveal] { opacity: 1 !important; transform: none !important; }
  /* A photographic section is white text on a dark scrim. On paper that is
     white text on white, because the scrim is a background nobody prints. The
     picture goes and the words come back in ink. */
  .has-bg { color: #000 !important; padding-block: 1rem !important; }
  .has-bg__layer { display: none !important; }
  .has-bg .tile, .has-bg .card, .has-bg .pill { background: none !important; border-color: #ccc !important; }
  body { background: #fff; color: #000; }
  .card, .tile { break-inside: avoid; border-color: #ccc; }
}

/* ---------------------------------------------------------------------------
   NARROW
   ------------------------------------------------------------------------ */
@media (max-width: 34rem) {
  /* Only where the burger is NOT running — without JavaScript the links have to
     wrap somewhere, and under the wordmark is the only place left. */
  html:not([data-js]) .bar__in { flex-wrap: wrap; }
  html:not([data-js]) .bar__nav { flex-wrap: wrap; gap: .2rem; }
  .band { padding-inline: 1.25rem; }
  .rows li, .steps li { gap: .1rem .6rem; }
}
`;

/* ===========================================================================
 * SITE.JS
 *
 * The two things markup alone cannot do, shipped with every template:
 * mounting the Instagram wall, and removing a section that turned out to have
 * nothing in it.
 *
 * crew-feed.js fills in figures and lists by itself. It deliberately does NOT
 * remove a list that came back empty, because on most pages an empty list still
 * has a fallback row worth showing. A section marked [data-crew-section] is
 * saying the opposite — it only makes sense with real rows in it — so this
 * takes those away.
 * ======================================================================== */
const SITE_JS = `/* Your site's own script.

   Everything here is an ENHANCEMENT. crew-feed.js has already filled in every
   figure and list by the time this runs, every block ships with a true fallback
   in its markup, and the header is a working row of links before a line of this
   executes. Delete the file and the site is plainer and still correct — which
   is the test each of these jobs had to pass to be in here:

     1. the menu           a panel on a phone, with the keyboard and the
                           scroll lock a menu is wrong without
     2. the header         a shadow once the page has moved under it, and its
                           measured height, which the menu panel is laid out to
     3. the current page   marked in the nav, worked out from the address
     4. arrival            sections rise into place the first time they are
                           reached, a row at a time
     5. the figures        counting up to the numbers the feed wrote
     6. the lightbox       a gallery picture, opened larger
     7. the Instagram wall and clearing away a section that came back empty

   Jobs 1 to 6 are pure DOM. Only 7 needs the feed. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* WHERE THE PANEL STOPS BEING A PANEL.
     Quoted once here and once in style.css, and the two must agree EXACTLY.
     They used to differ by a sixteenth of a rem, and a window resized into the
     gap between them kept the page's scroll lock with no menu on screen to
     explain it — the site simply stopped scrolling until it was reloaded. */
  var NARROW = '(max-width: 54rem)';

  /* This attribute is the contract with style.css: everything that would be
     broken or invisible without JavaScript is written behind html[data-js], so
     a page whose script never loads is never left with a hidden nav or a
     section stuck at opacity 0. */
  root.setAttribute('data-js', '');

  /* -------------------------------------------------------------------------
     HOW MUCH THIS SITE MOVES.

     Read from the page's own theme.css rather than written into this file,
     because this file is the same bytes on every site on the platform and the
     preset is the airline's. --motion is a word ('standard', 'cinematic'); the
     distances and durations that go with it are the other --motion-* properties
     and belong to the stylesheet, which is why none of them are read here.

     Two answers switch every moving thing below off: the airline chose Still,
     or the visitor's own system asked for less movement. The visitor's is the
     one that cannot be overruled.

     A theme.css written before motion existed has no --motion at all, and that
     reads as the default rather than as "off" — a site that has not been
     republished since should go on behaving the way it already did.
     --------------------------------------------------------------------- */
  var motion = 'standard';
  try {
    var declared = getComputedStyle(root).getPropertyValue('--motion').trim();
    if (declared) motion = declared;
  } catch (err) { /* a browser that cannot answer keeps the default */ }
  if (reduced) motion = 'none';
  var moves = motion !== 'none';
  /* The attribute is what style.css hangs the menu's stagger on, and its VALUE
     is the preset's name — so a design can say "only when this site is set to
     Cinematic" without this file needing to know that design exists. */
  if (moves) root.setAttribute('data-motion', motion);

  /* -------------------------------------------------------------------------
     1. THE MENU

     The button ships hidden in the markup and is revealed here, so there is
     never a control on the page that does nothing.

     Closing has four routes because a panel with fewer is a trap on one device
     or another: the button, the scrim, Escape, and following a link. Widening
     the window past the breakpoint closes it too — otherwise the panel's state
     survives into a layout that has no panel, and the links come back
     mid-header with the scrim still over them.
     --------------------------------------------------------------------- */
  (function menu() {
    var burger = document.querySelector('.bar__burger');
    var nav = document.getElementById('siteNav');
    var scrim = document.querySelector('.bar__scrim');
    if (!burger || !nav) return;

    burger.hidden = false;
    var open = false;

    function set(next) {
      if (next === open) return;
      open = next;
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { nav.setAttribute('data-open', ''); } else { nav.removeAttribute('data-open'); }
      if (scrim) {
        if (open) { scrim.hidden = false; requestAnimationFrame(function () { scrim.setAttribute('data-open', ''); }); }
        else { scrim.removeAttribute('data-open'); setTimeout(function () { if (!open) scrim.hidden = true; }, 220); }
      }
      /* The page must not scroll behind an open panel. Set on <html> rather
         than <body> so it holds on iOS as well.

         The gap is the scrollbar's own width, measured the instant BEFORE the
         lock removes it — window.innerWidth counts the scrollbar and
         clientWidth does not, so the difference is exactly what the page is
         about to gain. Zero on any device with overlay scrollbars, which is
         every phone, so the compensation costs nothing where it is not needed.
         See THE PAGE MUST NOT SCROLL in style.css for why this is measured
         rather than reserved in advance. */
      if (open) {
        var gap = window.innerWidth - root.clientWidth;
        root.style.setProperty('--lock-gap', (gap > 0 ? gap : 0) + 'px');
        root.setAttribute('data-nav-open', '');
      } else {
        root.removeAttribute('data-nav-open');
        root.style.removeProperty('--lock-gap');
      }

      if (open) {
        /* The panel opens at ITS OWN TOP, always. It is a scroll container, and
           a container keeps its scroll position between openings — so a visitor
           who scrolled down a long menu, closed it and opened it again used to
           get it back halfway down with the first links above the fold. */
        nav.scrollTop = 0;
        /* Focus follows the panel, so a keyboard user is inside the thing they
           just opened rather than behind the scrim.

           preventScroll is the important half: focusing an element normally
           scrolls its nearest scroll container to reveal it, and the first link
           sits under the panel's top padding — so the browser helpfully scrolled
           the padding away and the menu appeared to open already cut off at the
           top. Nothing needs revealing here; the panel is the whole screen. */
        var first = nav.querySelector('a');
        if (first) { try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); } }
      } else if (document.activeElement && nav.contains(document.activeElement)) {
        try { burger.focus({ preventScroll: true }); } catch (err) { burger.focus(); }
      }
    }

    burger.addEventListener('click', function () { set(!open); });
    if (scrim) scrim.addEventListener('click', function () { set(false); });
    nav.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) set(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) set(false); });

    // Trap Tab inside the panel while it is open. Short enough to be worth
    // doing by hand: the alternative is tabbing into a page the scrim is over.
    nav.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !open) return;
      var items = nav.querySelectorAll('a, button');
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    /* THE PANEL MUST NOT SURVIVE THE LAYOUT THAT HAS NO PANEL.

       Watching the SAME query the stylesheet uses, rather than its inverse
       written out by hand. The two were once 54rem and 54.0625rem: between them
       lay a band of window widths that matched neither, where the CSS had
       already turned the panel back into a row of links and this listener had
       not yet fired. The scroll lock stayed on, the scrim stayed up, and the
       page stopped scrolling with nothing on screen to say why.

       Belt and braces: set(false) is called whenever the query stops matching,
       and the lock is cleared unconditionally in case the panel was opened
       before this listener existed. */
    if (window.matchMedia) {
      var narrow = window.matchMedia(NARROW);
      var onChange = function (m) {
        if (!m.matches) {
          set(false);
          root.removeAttribute('data-nav-open');
          if (scrim) { scrim.removeAttribute('data-open'); scrim.hidden = true; }
        }
      };
      if (narrow.addEventListener) narrow.addEventListener('change', onChange);
      else if (narrow.addListener) narrow.addListener(onChange);
    }
  })();

  /* -------------------------------------------------------------------------
     2. THE HEADER'S SHADOW. A shadow that is there from the start reads as a
        floating strip; one that arrives on scroll reads as the page moving
        underneath. Passive, and it writes an attribute only when the answer
        changes, so scrolling is not a stream of style recalculations.
     --------------------------------------------------------------------- */
  (function header() {
    var bar = document.querySelector('[data-bar]');
    if (!bar) return;
    var on = false;
    var check = function () {
      var next = window.pageYOffset > 4;
      if (next === on) return;
      on = next;
      if (on) bar.setAttribute('data-scrolled', ''); else bar.removeAttribute('data-scrolled');
    };
    check();
    window.addEventListener('scroll', check, { passive: true });

    /* HOW TALL THE HEADER ACTUALLY IS.
       The menu panel's top padding is laid out against this. It cannot be a
       constant in the stylesheet, because the header's height is the airline's:
       a roundel logo and a short name give one height, a wordmark and "Trans
       Continental Virtual Airways" wrapping to two lines give another — and the
       constant used to be right for the first and put the first menu link
       underneath the wordmark for the second.

       ResizeObserver where it exists, because the height also changes when a
       long name reflows on rotation, and a resize listener alone misses the
       case where a web font arrives late and the name gets taller on its own. */
    var measure = function () {
      var h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) root.style.setProperty('--bar-h', h + 'px');
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(measure).observe(bar); } catch (err) { /* measured once is enough */ }
    } else {
      window.addEventListener('resize', measure, { passive: true });
    }
    // The logo and the name are the two things that change the header's height
    // after the fact — one when its image decodes, the other when the feed
    // writes the airline's real name in.
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(measure).catch(function () {});
    }
    window.addEventListener('load', measure);
  })();

  /* -------------------------------------------------------------------------
     3. THE CURRENT PAGE, marked in the nav.

        Worked out from the address rather than written into the markup,
        because the SAME rendered file is served at two addresses — the
        airline's own subdomain and inflight.info/va/<slug>/ — and a page that
        knew its own name would be wrong at one of them. Comparing resolved
        hrefs makes both right and needs nothing in the file.
     --------------------------------------------------------------------- */
  (function current() {
    var here = location.pathname.replace(/\\/index\\.html$/, '/').replace(/\\/+$/, '/') || '/';
    var links = document.querySelectorAll('.bar__nav a:not(.cta)');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href') || '';
      // Only our own pages. A link to the crew centre is not "this page".
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.indexOf('//') === 0) return;
      var path;
      try { path = new URL(a.href).pathname; } catch (err) { return; }
      path = path.replace(/\\/index\\.html$/, '/').replace(/\\/+$/, '/') || '/';
      if (path === here) a.setAttribute('aria-current', 'page');
    });
  })();

  /* -------------------------------------------------------------------------
     4. ARRIVAL.

        The attribute is added HERE and not in the markup, and only to sections
        that start below the fold. That is what keeps this from being a flash
        of invisible content: nothing already on screen is ever hidden, and a
        page whose script fails to load has no hidden sections at all because
        nothing ever marked them.

        Skipped entirely for anybody who asked their system for less movement.
     --------------------------------------------------------------------- */
  (function reveal() {
    if (!moves || !('IntersectionObserver' in window)) return;

    /* WHAT GETS A PLACE IN THE QUEUE.

       A stagger is only worth having over things that read as a SERIES — the
       aircraft in a fleet, the sectors in a network, the four figures. The
       heading above them is not one of a series; it is the thing that says what
       the series is, and delaying it behind its own list reads as the page
       loading badly rather than as choreography. So this is a list of grids and
       lists, not "every child of the section".

       .figures > div is in it because the figures ARE the row: four numbers
       arriving together is a block appearing, four arriving in sequence is an
       airline counting itself up. */
    var SERIES = '.cards > li, .tiles > li, .rows > li, .steps > li, .shots > li, .pills > li, .figures > div, .wall > *';

    /* Past this many, a queue stops reading as sequence and starts reading as
       lag: the twentieth card of a fleet would be waiting two seconds for its
       turn behind a preset with a hundred-millisecond step. Everything past the
       cap shares the last slot and arrives together. */
    var CAP = 12;

    var sections = document.querySelectorAll('main > section');
    var fold = window.innerHeight;
    var pending = [];
    Array.prototype.forEach.call(sections, function (el) {
      if (el.getBoundingClientRect().top < fold) return;   // already in view
      el.setAttribute('data-reveal', '');
      /* The index is written here and the delay is arithmetic in the
         stylesheet — see THE STAGGER there. Writing the delay itself would put
         the preset's timing in this file, which is the one thing it must not
         contain: these bytes are identical on every site on the platform. */
      var items = el.querySelectorAll(SERIES);
      Array.prototype.forEach.call(items, function (item, i) {
        item.setAttribute('data-reveal-item', '');
        item.style.setProperty('--i', String(Math.min(i, CAP)));
      });
      pending.push(el);
    });
    if (!pending.length) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.setAttribute('data-reveal', 'in');
        io.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    pending.forEach(function (el) { io.observe(el); });

    /* A LIST THAT ARRIVED LATE.

       crew-feed.js writes the fleet and the network in after this has run, and
       rows added to a section that was already marked would have no index — so
       they would all carry --i: 0 and arrive in one lump in the middle of a
       staggered page. Watching the marked sections for new children costs one
       observer and keeps the sequence correct however late the feed answers.

       Rows that land in a section which has ALREADY been reached are given the
       resting state immediately rather than a place in a queue that has been
       and gone: a row appearing at opacity 0 under a heading somebody is
       already reading is a row that never appears. */
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        var host = rec.target.closest ? rec.target.closest('[data-reveal]') : null;
        if (!host) return;
        var done = host.getAttribute('data-reveal') === 'in';
        var all = host.querySelectorAll(SERIES);
        Array.prototype.forEach.call(all, function (item, i) {
          if (item.hasAttribute('data-reveal-item')) return;
          item.setAttribute('data-reveal-item', '');
          item.style.setProperty('--i', String(done ? 0 : Math.min(i, CAP)));
        });
      });
    });
    pending.forEach(function (el) { mo.observe(el, { childList: true, subtree: true }); });
  })();

  /* -------------------------------------------------------------------------
     5. THE FIGURES, COUNTING UP.

     The one piece of motion here that is about what the number MEANS rather
     than about where it sits. "1,284 hours flown" landing fully formed is a
     fact on a page; the same number climbing to itself is an airline that has
     been flying. It is the reason a stats band is on a VA's site at all, so it
     is worth the fifty lines.

     THE THREE THINGS THAT MAKE IT SAFE

     1. IT NEVER INVENTS A NUMBER. The value counted to is parsed back out of
        what crew-feed.js already wrote into the element. If that text is not a
        plain number — a dash, an em dash, "coming soon", a figure with a unit
        the feed decided to spell out — nothing happens at all and the text
        stays exactly as it was found. There is no path here that leaves a wrong
        figure on an airline's website.

     2. IT WAITS FOR THE FEED RATHER THAN RACING IT. A figure starts as a
        fallback dash and becomes a number whenever the crew centre answers,
        which may be before this runs or a second after. So each one is watched:
        if it is a number now it counts now, and if it becomes one later it
        counts then. A slow network changes when it happens and not whether.

     3. IT COUNTS ONLY WHAT IS ON SCREEN, ONCE. Off-screen it is pointless, and
        twice is a glitch.

     Only for presets that asked for it — Still and Subtle get their figures the
     moment the feed does.
     --------------------------------------------------------------------- */
  (function countUp() {
    if (!moves || !('IntersectionObserver' in window)) return;
    var wanted = false;
    try { wanted = getComputedStyle(root).getPropertyValue('--motion-count').trim() === '1'; }
    catch (err) { return; }
    if (!wanted) return;

    var cells = document.querySelectorAll('.figures [data-crew-stat]');
    if (!cells.length) return;

    /* What the element says, as a number — or null, which means leave it alone.

       The separators are kept and reapplied so that a figure the feed wrote as
       "12,480" counts up as "1,248" and not as "1248" with the comma appearing
       at the end. Anything with a decimal point, a letter or a sign in it is
       refused: those are formats this cannot take apart and put back together
       with confidence, and a figure it is not confident about is a figure it
       does not touch. */
    function readable(el) {
      var text = (el.textContent || '').trim();
      if (!/^[0-9][0-9,\\u00a0\\u202f ]*$/.test(text)) return null;
      var digits = text.replace(/[^0-9]/g, '');
      if (!digits.length || digits.length > 12) return null;
      var value = parseInt(digits, 10);
      // Nothing to watch climb, and a flicker where a number should be.
      if (!isFinite(value) || value < 10) return null;
      /* The separator THE FEED ITSELF USED, not the browser's idea of one.
         toLocaleString would count "12,480" up through "1.248" for a visitor in
         Berlin and then snap to a comma on the final frame. */
      var sep = (text.match(/[,\\u00a0\\u202f ]/) || [null])[0];
      return { value: value, sep: sep };
    }

    /* Thousands, in whatever separator the page is already using. */
    function group(n, sep) {
      var s = String(n);
      if (!sep) return s;
      var out = '';
      for (var i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += sep;
        out += s.charAt(i);
      }
      return out;
    }

    function run(el) {
      var found = readable(el);
      if (!found) return false;
      var target = found.value;
      var sep = found.sep;
      var ms = 900 + Math.min(700, String(target).length * 120);
      var start = 0;
      el.setAttribute('data-counting', '');

      function frame(now) {
        if (!start) start = now;
        var t = Math.min(1, (now - start) / ms);
        // Out-cubic. Fast at first and settling onto the value, which is what
        // makes the last few hundred readable instead of a blur.
        var eased = 1 - Math.pow(1 - t, 3);
        var at = Math.round(target * eased);
        el.textContent = group(at, sep);
        if (t < 1) { requestAnimationFrame(frame); return; }
        // Written from the stored target rather than from the last frame, so
        // the figure that ends up on the page is the feed's own number however
        // the rounding went on the way there.
        el.textContent = group(target, sep);
        el.removeAttribute('data-counting');
      }
      requestAnimationFrame(frame);
      return true;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        io.unobserve(el);
        if (run(el)) return;
        /* Not a number yet. The crew centre has not answered, or has answered
           with something this cannot count. Watch the element itself: if a
           number arrives it counts then, and if one never does the fallback the
           airline wrote stays on the page untouched, which is the whole
           contract every block on this site is built on.

           Given up on after twelve seconds so a site whose crew centre is down
           is not left with an observer per figure for as long as the tab is
           open. */
        if (typeof MutationObserver !== 'function') return;
        var mo = new MutationObserver(function () {
          if (run(el)) { mo.disconnect(); clearTimeout(giveUp); }
        });
        mo.observe(el, { childList: true, characterData: true, subtree: true });
        var giveUp = setTimeout(function () { mo.disconnect(); }, 12000);
      });
    }, { rootMargin: '0px 0px -10% 0px' });

    Array.prototype.forEach.call(cells, function (el) { io.observe(el); });
  })();

  /* -------------------------------------------------------------------------
     6. THE LIGHTBOX

        A gallery tile that opens its picture larger. The tile is already a
        <button> in the markup — the builder decided that, because a thing you
        click to open something is a control — so all this does is open the
        dialog and put the right picture in it.

        A <dialog>, so the browser supplies the modal behaviour that is tedious
        and easy to get wrong: the top layer, the backdrop, Escape, and giving
        focus back to the tile that opened it. Nothing here reimplements any of
        that.

        The dialog is BUILT ON FIRST USE rather than shipped in every page. A
        site with no gallery never makes one, and a site with one makes it the
        first time somebody clicks a picture — by which point they have told us
        they want it.
     --------------------------------------------------------------------- */
  (function lightbox() {
    var tiles = document.querySelectorAll('[data-shot]');
    if (!tiles.length) return;
    // A browser without <dialog> leaves the tiles as buttons that do nothing,
    // which is worse than a tile that is not a button at all — so in that case
    // each one is turned into a plain link to the picture instead.
    if (typeof HTMLDialogElement === 'undefined') {
      Array.prototype.forEach.call(tiles, function (t) {
        var a = document.createElement('a');
        a.className = t.className;
        a.href = t.getAttribute('data-shot');
        a.target = '_blank';
        a.rel = 'noopener';
        a.innerHTML = t.innerHTML;
        t.parentNode.replaceChild(a, t);
      });
      return;
    }

    var box = null, pic = null, cap = null;

    function build() {
      box = document.createElement('dialog');
      box.className = 'lightbox';
      var fig = document.createElement('figure');
      fig.style.margin = '0';
      fig.style.position = 'relative';
      pic = document.createElement('img');
      cap = document.createElement('figcaption');
      var shut = document.createElement('button');
      shut.type = 'button';
      shut.className = 'lightbox__shut';
      shut.setAttribute('aria-label', 'Close');
      shut.innerHTML = '&times;';
      shut.addEventListener('click', function () { box.close(); });
      fig.appendChild(pic);
      fig.appendChild(cap);
      fig.appendChild(shut);
      box.appendChild(fig);
      // Clicking the backdrop shuts it. The dialog's own box is the figure, so
      // a click that landed on the dialog itself landed outside the picture.
      box.addEventListener('click', function (e) { if (e.target === box) box.close(); });
      document.body.appendChild(box);
    }

    document.addEventListener('click', function (e) {
      var tile = e.target.closest ? e.target.closest('[data-shot]') : null;
      if (!tile) return;
      if (!box) build();
      pic.src = tile.getAttribute('data-shot');
      var text = tile.getAttribute('data-caption') || '';
      cap.textContent = text;
      cap.hidden = !text;
      pic.alt = text;
      box.showModal();
    });
  })();

  /* -------------------------------------------------------------------------
     7. THE FEED'S TWO LEFTOVERS

        crew-feed.js fills in figures and lists by itself. It deliberately does
        NOT remove a list that came back empty, because on most pages an empty
        list still has a fallback row worth showing. A section marked
        [data-crew-section] is saying the opposite — it only makes sense with
        real rows in it — so this takes those away.
     --------------------------------------------------------------------- */
  function pruneEmpty() {
    document.querySelectorAll('[data-crew-section]').forEach(function (el) {
      var list = el.querySelector('[data-crew-list]');
      if (!list) return;
      if (list.getAttribute('data-crew-filled') === null) el.remove();
    });
  }

  /* THE FEED SCRIPT ITSELF DID NOT LOAD.

     Offline, blocked by an extension, or the request simply failed. Every
     figure and every list keeps the fallback written into the markup, which is
     the whole design — except for the sections that said they only make sense
     with real rows in them. Those would be left as a heading over nothing,
     which is the one outcome this attribute exists to prevent, so they go now
     rather than waiting for a feed that is not coming. */
  if (!window.CrewFeed) { pruneEmpty(); return; }

  /* THE INSTAGRAM WALL.

     THE ADDRESS IS BUILT HERE, from the shortcode, after checking it against
     [A-Za-z0-9_-]. crew-feed.js already did the same thing, and this does it
     again anyway: a src is the one attribute on this page where being wrong
     means somebody else's script runs on your domain. */
  var KINDS = { p: 1, reel: 1, tv: 1 };

  function fit(tile) {
    var frame = tile.querySelector('iframe');
    if (frame && tile.clientWidth) frame.style.transform = 'scale(' + (tile.clientWidth / 326) + ')';
  }

  function mount(tile) {
    if (tile.dataset.mounted) return;
    tile.dataset.mounted = '1';
    var frame = document.createElement('iframe');
    frame.src = tile.dataset.embed;
    frame.title = 'Instagram post';
    frame.loading = 'lazy';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    tile.innerHTML = '';
    tile.appendChild(frame);
    fit(tile);
  }

  function paintWall(data) {
    var section = document.getElementById('wall');
    if (!section) return;
    var posts = (data && data.posts ? data.posts : []).filter(function (p) {
      return p && KINDS[p.kind] && /^[A-Za-z0-9_-]{1,64}$/.test(String(p.code || ''));
    });
    if (!posts.length) { section.remove(); return; }

    var grid = document.getElementById('wallGrid');
    grid.innerHTML = posts.map(function (p) {
      var src = 'https://www.instagram.com/' + p.kind + '/' + p.code + '/embed/';
      return '<button class="wall__tile" type="button" data-embed="' + src + '" aria-label="Open an Instagram post">View post</button>';
    }).join('');

    var tiles = Array.prototype.slice.call(grid.querySelectorAll('.wall__tile'));
    grid.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.wall__tile') : null;
      if (t) mount(t);
    });

    // A tile stays a button until it is scrolled to. Nine Instagram embeds is
    // several megabytes for a section most visitors never reach.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          mount(en.target); io.unobserve(en.target);
        });
      }, { rootMargin: '200px' });
      tiles.forEach(function (t) { io.observe(t); });
    } else {
      tiles.forEach(mount);
    }

    var timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { tiles.forEach(fit); }, 150);
    });

    if (data.handle) {
      var h = document.getElementById('wallHandle');
      if (h) {
        h.innerHTML = '<a href="https://www.instagram.com/' + data.handle + '/" rel="noopener" target="_blank">@' + data.handle + '</a>';
        h.hidden = false;
      }
    }
    section.hidden = false;
  }

  // CrewFeed.mount() has already run by the time this file executes, but the
  // lists it filled resolve on the network. Wait for its pass to settle.
  CrewFeed.mount().then(function () {
    pruneEmpty();
    return CrewFeed.posts().then(function (posts) {
      return posts ? { posts: posts, handle: posts[0] && posts[0].handle } : null;
    });
  }).then(paintWall).catch(function () { /* the page was already correct */ });
})();
`;

/* ===========================================================================
 * THE TEMPLATES
 *
 * Six. Each is its own design, not a recolour: swap any two accents and you
 * still have two pages nothing like each other.
 * ======================================================================== */
const TEMPLATES = {

    flightline: {
        name: 'Flightline',
        blurb: 'Editorial and confident. A big serif headline over a band of live figures.',
        tags: ['Editorial', 'Light', 'Most popular'],
        font: 'editorial',
        mode: 'auto',
        accent: '#14375e',
        pattern: 'none',
        radius: 6,
        motion: 'standard',
        css: `/* Flightline — editorial. Wide measure, generous air, a rule under every
   heading so the page reads as sections rather than one long column. */
:root { --measure: 64rem; --gap: clamp(3rem, 7vw, 5.5rem); }
.hero { padding-top: clamp(3.5rem, 9vw, 7rem); }
h1 { font-weight: 700; font-variation-settings: 'SOFT' 40, 'WONK' 1; }
h2 { padding-bottom: .7rem; border-bottom: 2px solid var(--ink); display: inline-block; }
.block { border-top: 1px solid var(--line); }
.figures { border-top: 3px solid var(--accent); }
.figures b { color: var(--accent); }
.bar { border-bottom: 1px solid var(--line); }
/* Cards and tiles keep the page's own hairline rather than a surface fill —
   a fill would put a second background inside a design whose whole structure
   is rules on paper. */
.card, .tile { background: none; }
.card__media { background: var(--surface); }
.band { border-radius: 0; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'hubs', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'quote', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<rect x="0" y="0" width="160" height="14" fill="#f3f4f7"/>
<rect x="10" y="26" width="86" height="9" rx="1" fill="#14375e"/>
<rect x="10" y="39" width="62" height="5" rx="1" fill="#c9cfda"/>
<rect x="10" y="56" width="140" height="2" fill="#14375e"/>
<g fill="#14375e"><rect x="10" y="64" width="18" height="10" rx="1"/><rect x="45" y="64" width="18" height="10" rx="1"/><rect x="80" y="64" width="18" height="10" rx="1"/><rect x="115" y="64" width="18" height="10" rx="1"/></g>
<g fill="#e4e7ec"><rect x="10" y="88" width="140" height="4"/><rect x="10" y="97" width="140" height="4"/><rect x="10" y="106" width="110" height="4"/></g>`,
    },

    concourse: {
        name: 'Concourse',
        blurb: 'A departure board. Dark, dense, monospaced — the airline as an operation.',
        tags: ['Dark', 'Technical', 'Dense'],
        font: 'technical',
        mode: 'dark',
        accent: '#f2a03d',
        pattern: 'grid',
        radius: 2,
        motion: 'subtle',
        css: `/* Concourse — a departure board. Tight leading, mono everywhere, the accent
   used the way a board uses amber: for the live numbers and nothing else. */
:root { --measure: 68rem; --gap: clamp(2.2rem, 5vw, 3.6rem); --motif-opacity: .5; }
body { font-size: 15px; }
h1 { font-weight: 700; letter-spacing: -.03em; text-transform: uppercase; }
h2 {
  font-family: var(--font-mono); font-size: .82rem; letter-spacing: .18em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 1rem;
}
.block__head p { font-family: var(--font-mono); font-size: .76rem; letter-spacing: .06em; }
.bar { border-bottom: 1px solid var(--line); font-family: var(--font-mono); }
.bar__nav a { font-family: var(--font-mono); font-size: .78rem; letter-spacing: .08em; text-transform: uppercase; }
.block { border-top: 1px solid var(--line); }
.figures { gap: 1rem; }
.figures b { color: var(--accent); font-family: var(--font-mono); letter-spacing: -.02em; }
.figures span { font-family: var(--font-mono); font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; }
/* The rows are the board: fixed columns, a rule between every one. */
.rows li, .steps li { padding: .55rem 0; font-family: var(--font-mono); font-size: .84rem; }
.rows li b { color: var(--accent); }
.rows span, .steps span { font-family: var(--font-body); }
.tile .code, .pill { font-family: var(--font-mono); }
.card__body b { font-family: var(--font-mono); font-size: .84rem; letter-spacing: .02em; }
.band { background: var(--surface); color: var(--ink); border-top: 2px solid var(--accent); border-radius: 0; }
.band .cta { background: var(--accent); color: #12141a; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'activity', 'network', 'hubs', 'events', 'notices', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'staff', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#12141a"/>
<rect x="0" y="0" width="160" height="12" fill="#1b1e26"/>
<rect x="10" y="22" width="70" height="8" rx="1" fill="#e8eaf0"/>
<g fill="#f2a03d"><rect x="10" y="40" width="14" height="8" rx="1"/><rect x="42" y="40" width="14" height="8" rx="1"/><rect x="74" y="40" width="14" height="8" rx="1"/><rect x="106" y="40" width="14" height="8" rx="1"/></g>
<g fill="#2a2e38"><rect x="10" y="60" width="140" height="1"/><rect x="10" y="70" width="140" height="1"/><rect x="10" y="80" width="140" height="1"/><rect x="10" y="90" width="140" height="1"/><rect x="10" y="100" width="140" height="1"/></g>
<g fill="#f2a03d"><rect x="10" y="63" width="22" height="4"/><rect x="10" y="73" width="22" height="4"/><rect x="10" y="83" width="22" height="4"/><rect x="10" y="93" width="22" height="4"/></g>
<g fill="#4a505e"><rect x="40" y="63" width="60" height="4"/><rect x="40" y="73" width="72" height="4"/><rect x="40" y="83" width="52" height="4"/><rect x="40" y="93" width="66" height="4"/></g>`,
    },

    horizon: {
        name: 'Horizon',
        blurb: 'Airy and modern. Lots of white, a wide hero, everything given room.',
        tags: ['Light', 'Spacious', 'Modern'],
        font: 'grotesk',
        mode: 'light',
        accent: '#1b5fc1',
        pattern: 'none',
        radius: 16,
        motion: 'standard',
        css: `/* Horizon — air. The design decision here is restraint: one accent, one
   weight of rule, and a great deal of space doing the work a border would. */
:root { --measure: 70rem; --gap: clamp(4rem, 10vw, 8rem); }
.hero { padding-top: clamp(4rem, 12vw, 9rem); text-align: center; }
.hero .lede { margin-left: auto; margin-right: auto; }
.hero .actions { justify-content: center; }
h1 { font-weight: 500; letter-spacing: -.035em; }
h2 { text-align: center; color: var(--muted); font-weight: 500; }
.block__head { text-align: center; }
.block__head p { margin-inline: auto; }
.figures { text-align: center; gap: 2.5rem; }
.figures b { font-weight: 500; }
/* Centred as a block, left-aligned as text. A paragraph set centre-aligned is
   hard to read; one hanging off the left under a centred heading looks like a
   mistake. Centring the column and not the lines is the way out of both. */
.prose { margin-inline: auto; }
.rows li, .steps li { border-top: 0; border-bottom: 1px solid var(--line); }
.rows li:last-child { border-bottom: 1px solid var(--line); }
.more, .pills { justify-content: center; text-align: center; }
.card, .tile { border-color: var(--line-soft); box-shadow: var(--shadow-1); }
.quote { text-align: center; }
.quote p { margin-inline: auto; }
.band { margin-left: var(--pad); margin-right: var(--pad); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'about', 'values', 'network', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'quote', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<circle cx="14" cy="10" r="3" fill="#1b5fc1"/>
<rect x="34" y="24" width="92" height="9" rx="2" fill="#20242c"/>
<rect x="48" y="39" width="64" height="4" rx="2" fill="#c9cfda"/>
<rect x="60" y="51" width="40" height="10" rx="5" fill="#1b5fc1"/>
<g fill="#1b5fc1"><rect x="20" y="76" width="16" height="9" rx="1"/><rect x="58" y="76" width="16" height="9" rx="1"/><rect x="96" y="76" width="16" height="9" rx="1"/></g>
<g fill="#eef1f5"><rect x="20" y="100" width="120" height="3" rx="1.5"/><rect x="20" y="109" width="90" height="3" rx="1.5"/></g>`,
    },

    terminal: {
        name: 'Terminal',
        blurb: 'Nothing but type and rules. Loads instantly, works anywhere, ages well.',
        tags: ['Minimal', 'Fast', 'Technical'],
        font: 'technical',
        mode: 'auto',
        accent: '#0e8c5a',
        pattern: 'none',
        radius: 0,
        motion: 'none',
        css: `/* Terminal — a document, not a brochure. No cards, no shadows, no images.
   A narrow measure and one rule weight, because the only thing on this page is
   what the airline actually says. */
:root { --measure: 44rem; --gap: clamp(2rem, 5vw, 3rem); }
body { font-size: 15px; }
h1 { font-size: clamp(1.5rem, 4vw, 2.1rem); font-weight: 700; }
h2 { font-size: .95rem; text-transform: uppercase; letter-spacing: .1em; color: var(--accent); }
.bar { border-bottom: 2px solid var(--ink); }
.block { border-top: 1px solid var(--line); }
.lede { font-size: 1rem; }
.figures { display: block; }
.figures > div { display: flex; gap: .6rem; align-items: baseline; padding: .35rem 0; }
.figures b { font-size: 1.1rem; font-family: var(--font-mono); min-width: 5rem; }
.figures span { font-size: .9rem; }
.rows li, .steps li { padding: .5rem 0; }
.cta { background: none; color: var(--accent); border: 1px solid currentColor; }
.cta:hover { filter: none; background: var(--accent); color: var(--on-accent); }
/* No fills anywhere. A card here is a rule and a gap, which is what the rest of
   the page already is — the fleet reads as another section of the document
   rather than as a widget that wandered in from a different site. */
.card, .tile { background: none; border: 0; border-top: 1px solid var(--line); border-radius: 0; }
.cards, .tiles { gap: 0 1.6rem; }
.card__media { display: none; }
.card__body, .tile { padding: .55rem 0; }
.pill { border-radius: 0; background: none; border-color: var(--line); }
.quote p { font-family: var(--font-body); font-size: 1.05rem; font-style: italic; }
/* This design is a document. A banner running to the window belongs on a
   brochure; here it stays inside the measure with the words. */
.hero__bg { margin-inline: 0; }
.band { background: none; color: var(--ink); border-top: 2px solid var(--ink); border-radius: 0; text-align: left; padding-left: 0; padding-right: 0; max-width: var(--measure); margin: var(--gap) auto 0; }
.band p { margin-inline: 0; }
.band .actions { justify-content: flex-start; }
.band .cta { background: none; color: var(--accent); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'activity', 'notices', 'events', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks'] },
            { path: 'about.html', title: 'About', blocks: ['about', 'values', 'joining', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fbfbfa"/>
<rect x="14" y="14" width="132" height="2" fill="#1a1c1e"/>
<rect x="14" y="26" width="66" height="7" rx="1" fill="#1a1c1e"/>
<rect x="14" y="39" width="94" height="3" fill="#b8bdc4"/>
<g fill="#0e8c5a"><rect x="14" y="54" width="10" height="4"/><rect x="14" y="62" width="10" height="4"/><rect x="14" y="70" width="10" height="4"/></g>
<g fill="#c9cdd3"><rect x="30" y="54" width="46" height="4"/><rect x="30" y="62" width="38" height="4"/><rect x="30" y="70" width="52" height="4"/></g>
<rect x="14" y="86" width="132" height="1" fill="#dfe2e6"/>
<g fill="#dfe2e6"><rect x="14" y="93" width="132" height="3"/><rect x="14" y="101" width="132" height="3"/><rect x="14" y="109" width="100" height="3"/></g>`,
    },

    cabin: {
        name: 'Cabin',
        blurb: 'Warm and friendly. Rounded, card-based — good for a crew that is still small.',
        tags: ['Light', 'Friendly', 'Cards'],
        font: 'humanist',
        mode: 'light',
        accent: '#c05a2e',
        pattern: 'weave',
        radius: 18,
        motion: 'standard',
        css: `/* Cabin — warm. Everything sits in a card with a soft edge; the point is that
   a small airline looks deliberate rather than sparse. */
:root { --measure: 60rem; --gap: clamp(2.5rem, 6vw, 4rem); --motif-opacity: .7; }
h1 { font-weight: 700; letter-spacing: -.025em; }
.bar { padding-top: .5rem; }
.hero { text-align: center; }
.hero .lede { margin-inline: auto; }
.hero .actions { justify-content: center; }
.block, .figures {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: clamp(1.5rem, 4vw, 2.4rem);
  margin-bottom: 1.2rem;
}
.block__head { text-align: center; }
.block__head p { margin-inline: auto; }
.figures { text-align: center; }
.figures b { color: var(--accent); }
.rows li, .steps li { border-top: 1px dashed var(--line); }
.rows li:first-child, .steps li:first-child { border-top: 0; }
.rows li:last-child, .steps li:last-child { border-bottom: 0; }
/* A card INSIDE a card needs the deeper surface, or the two fills are the same
   colour and the nesting disappears. */
.card, .tile { background: var(--bg); }
.pills { justify-content: center; }
.quote { text-align: center; }
.quote p { margin-inline: auto; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'about', 'values', 'activity', 'network', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'quote', 'staff', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fdf8f4"/>
<rect x="10" y="8" width="140" height="16" rx="8" fill="#fff" stroke="#eadfd6"/>
<rect x="52" y="34" width="56" height="8" rx="2" fill="#2a221d"/>
<rect x="10" y="52" width="140" height="26" rx="10" fill="#fff" stroke="#eadfd6"/>
<g fill="#c05a2e"><rect x="26" y="60" width="14" height="9" rx="2"/><rect x="62" y="60" width="14" height="9" rx="2"/><rect x="98" y="60" width="14" height="9" rx="2"/></g>
<rect x="10" y="84" width="140" height="28" rx="10" fill="#fff" stroke="#eadfd6"/>
<g fill="#e8dcd2"><rect x="24" y="92" width="112" height="3" rx="1.5"/><rect x="24" y="101" width="86" height="3" rx="1.5"/></g>`,
    },

    livery: {
        name: 'Livery',
        blurb: 'Colour-forward. Your accent used in full-width blocks, like a poster.',
        tags: ['Bold', 'Colour', 'Poster'],
        font: 'grotesk',
        mode: 'light',
        accent: '#d8102f',
        pattern: 'chevron',
        radius: 0,
        motion: 'expressive',
        css: `/* Livery — the accent as the design. The hero is a full block of it and the
   figures sit on it, which is only legible because --on-accent is part of the
   theme rather than assumed to be white. */
:root { --measure: 66rem; --gap: clamp(3rem, 7vw, 5rem); --bar-bg: var(--accent); }
h1 { font-weight: 700; letter-spacing: -.04em; text-transform: uppercase; }
h2 { font-weight: 700; text-transform: uppercase; letter-spacing: -.01em; }
.bar { color: var(--on-accent); border-bottom: 0; }
.bar .mark, .bar__nav a { color: var(--on-accent); }
.bar__nav a:hover { color: var(--on-accent); background: color-mix(in srgb, currentColor 16%, transparent); }
.bar .cta { background: var(--on-accent); color: var(--accent); }
.bar__burger { border-color: color-mix(in srgb, currentColor 45%, transparent); color: var(--on-accent); }
/* The panel is the page's own background, not the bar's — a slide-out in the
   accent with accent-coloured links in it is a block of one colour. */
.bar__nav[data-open] a { color: var(--ink); }
.bar__nav[data-open] .cta { background: var(--accent); color: var(--on-accent); }
/* The hero and the figures are one block of colour, EDGE TO EDGE.

   Full bleed by restructuring rather than by negative margins. A block inside a
   centred main cannot escape it with "margin: 0 -pad": that cancels the padding
   and leaves the centring gutter, so the colour stops short of the viewport on
   any screen wider than the measure — which is every desktop. So main gives up
   its own width here, every block takes the measure back, and the bleeding ones
   keep their text on the same left edge with a padding that grows to fill the
   gutter. No vw units, so a scrollbar cannot cause a horizontal overflow. */
main { max-width: none; padding: 0; }
main > * { max-width: var(--measure); margin-inline: auto; }
/* A class, not a child selector: BASE's own .block rule outranks a type
   selector and would zero this out. */
.block { padding-inline: var(--pad); }
.hero, .figures, .band {
  max-width: none; color: var(--on-accent); background: var(--accent);
  padding-inline: max(var(--pad), calc((100% - var(--measure)) / 2 + var(--pad)));
  border-radius: 0;
}
.hero { padding-top: clamp(3rem, 8vw, 6rem); padding-bottom: 0; }
.hero .eyebrow, .hero .lede { color: inherit; opacity: .8; }
.hero .cta { background: var(--on-accent); color: var(--accent); }
.hero .cta--ghost { background: none; color: inherit; border-color: color-mix(in srgb, currentColor 45%, transparent); }
.figures { padding-block: clamp(2rem, 5vw, 3.5rem); }
/* The hero and the figures are ONE block of colour, so they are one block of
   motif too. Without this the pattern stops at the hero's last pixel and the
   two halves read as two slightly different reds — which is worse than no
   pattern at all, because it looks like a rendering fault rather than a
   decision. The hero carries data-motif; the figures cannot (a bare .figures
   is not patterned in any other design), so Livery paints its own. */
.figures { position: relative; isolation: isolate; }
.figures::before {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: var(--motif-image, none);
  background-size: var(--motif-size, auto);
  background-position: var(--motif-position, 0 0);
}
.band { margin-top: 0; }
/* The band runs straight into the footer's rule. A gap of page between a
   full-bleed block of colour and the line under it is a seam. */
footer { margin-top: 0; }
.figures span { color: inherit; opacity: .75; }
.block { border-top: 4px solid var(--ink); }
.rows li b, .steps li b, .card__body b { text-transform: uppercase; letter-spacing: -.01em; }
.card, .tile, .pill, .card__media img { border-radius: 0; }
footer { border-top: 4px solid var(--ink); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'hubs', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fff"/>
<rect x="0" y="0" width="160" height="12" fill="#d8102f"/>
<rect x="0" y="12" width="160" height="58" fill="#d8102f"/>
<rect x="12" y="24" width="80" height="11" rx="1" fill="#fff"/>
<rect x="12" y="41" width="56" height="4" rx="1" fill="#ffb3bf"/>
<g fill="#fff"><rect x="12" y="54" width="16" height="9" rx="1"/><rect x="48" y="54" width="16" height="9" rx="1"/><rect x="84" y="54" width="16" height="9" rx="1"/><rect x="120" y="54" width="16" height="9" rx="1"/></g>
<rect x="12" y="80" width="136" height="3" fill="#16181d"/>
<g fill="#e4e7ec"><rect x="12" y="92" width="136" height="4"/><rect x="12" y="101" width="136" height="4"/><rect x="12" y="110" width="104" height="4"/></g>`,
    },

    /* HERITAGE — the design for an airline that has a culture and wants it on
     * the page rather than in a Discord channel.
     *
     * The motif is not decoration here, it is the structure: it runs behind the
     * hero, along the band and across a rule between every section, so the
     * pattern a VA picks is the thing a visitor remembers about the site. Every
     * other design treats a motif as an option; this one is built around it,
     * which is what makes it a different design rather than a recolour. */
    heritage: {
        name: 'Heritage',
        blurb: 'Pattern-led. Your motif runs through the whole page — for an airline with a story to tell.',
        tags: ['Editorial', 'Pattern', 'Warm'],
        font: 'editorial',
        mode: 'light',
        accent: '#1f5c4a',
        pattern: 'diamond',
        radius: 4,
        motion: 'subtle',
        css: `/* Heritage — the motif as the structure. Nothing here is a card: the page is
   held together by patterned rules and one deep accent, the way a printed
   timetable from 1974 is. */
:root { --measure: 62rem; --gap: clamp(3rem, 7vw, 5.5rem); --motif-opacity: .9; }
h1 { font-weight: 700; font-variation-settings: 'SOFT' 30, 'WONK' 1; letter-spacing: -.03em; }
h2 { font-size: clamp(1.3rem, 3vw, 1.8rem); }
.eyebrow { color: var(--accent); }
.bar { border-bottom: 1px solid var(--line); }

/* THE PATTERNED RULE.

   A band of the motif between sections rather than a hairline. It is a
   ::before on the block (the motif's own layer is a ::before too, but only on
   [data-motif] blocks, and these two never land on the same element) so it
   costs no extra markup and cannot get out of step with the section it belongs
   to. Six pixels, because a patterned rule any taller starts being a section
   of its own. */
.block + .block::before,
.figures + .block::before {
  content: ''; display: block; height: 6px; margin-bottom: calc(var(--gap) * .5);
  background-image: var(--motif-image, none);
  background-size: var(--motif-size, auto);
  background-position: var(--motif-position, 0 0);
  color: var(--accent);
  opacity: .85;
}
@supports not (background: color-mix(in srgb, currentColor 10%, transparent)) {
  .block + .block::before, .figures + .block::before { background-image: none; border-top: 1px solid var(--line); height: 0; }
}

.hero { padding-block: clamp(3.5rem, 10vw, 7rem); }
.figures { border-block: 2px solid var(--accent); }
.figures b { color: var(--accent); font-variation-settings: 'SOFT' 20; }
.rows li, .steps li { border-top-color: var(--line-soft); }
.card, .tile { background: none; border-color: var(--line); }
.card__media { background: var(--surface); }
.pill { border-color: var(--accent-line); background: var(--accent-soft); }
.quote p { font-variation-settings: 'SOFT' 60, 'WONK' 1; }
.band { border-radius: 0; }
.band p { opacity: .9; }
footer { border-top: 2px solid var(--accent); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'values', 'about', 'network', 'hubs', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'quote', 'staff', 'partners', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fbf9f4"/>
<rect x="0" y="0" width="160" height="13" fill="#fff"/>
<rect x="0" y="13" width="160" height="1" fill="#e3ded2"/>
<g stroke="#1f5c4a" stroke-width="1" opacity=".45">
<path d="M0 20 L14 34 M14 20 L0 34 M14 20 L28 34 M28 20 L14 34 M28 20 L42 34 M42 20 L28 34 M42 20 L56 34 M56 20 L42 34 M56 20 L70 34 M70 20 L56 34 M70 20 L84 34 M84 20 L70 34 M84 20 L98 34 M98 20 L84 34 M98 20 L112 34 M112 20 L98 34 M112 20 L126 34 M126 20 L112 34 M126 20 L140 34 M140 20 L126 34 M140 20 L154 34 M154 20 L140 34"/>
</g>
<rect x="12" y="44" width="88" height="10" rx="1" fill="#23201a"/>
<rect x="12" y="59" width="60" height="4" rx="1" fill="#b9b3a4"/>
<rect x="12" y="74" width="136" height="2" fill="#1f5c4a"/>
<g fill="#1f5c4a"><rect x="12" y="81" width="18" height="9" rx="1"/><rect x="48" y="81" width="18" height="9" rx="1"/><rect x="84" y="81" width="18" height="9" rx="1"/><rect x="120" y="81" width="18" height="9" rx="1"/></g>
<rect x="12" y="95" width="136" height="2" fill="#1f5c4a"/>
<g fill="#e0dccf"><rect x="12" y="104" width="136" height="4"/><rect x="12" y="112" width="104" height="4"/></g>`,
    },

    /* SKYLINE — for the airline whose photographs are the reason to look.
     *
     * Dark, and the only design where a picture is allowed to be the largest
     * thing on the screen. Everything else is deliberately quiet so that the
     * banner and the fleet cards are what the eye lands on: the type is one
     * weight, the rules are almost invisible and the accent appears about four
     * times per page. */
    skyline: {
        name: 'Skyline',
        blurb: 'Photographic. Dark, cinematic, built around your banner and your fleet pictures.',
        tags: ['Dark', 'Photographic', 'Modern'],
        font: 'grotesk',
        mode: 'dark',
        accent: '#4da3ff',
        pattern: 'dots',
        radius: 14,
        motion: 'cinematic',
        css: `/* Skyline — the pictures are the page. Quiet type, near-invisible rules, and
   one accent used sparingly, so that nothing on screen competes with a
   photograph. */
:root { --measure: 72rem; --gap: clamp(3.5rem, 8vw, 6rem); --motif-opacity: .6; }
h1 { font-weight: 600; letter-spacing: -.04em; }
h2 { font-weight: 600; letter-spacing: -.025em; }
.eyebrow { color: var(--accent); }
.bar { border-bottom: 1px solid var(--line-soft); }

/* THE HERO IS THE PHOTOGRAPH. Taller than any other design's, and the scrim
   runs bottom-to-top rather than left-to-right — the words sit at the foot of
   the picture rather than beside it, which is what makes it read as a frame
   from a film instead of a banner with a caption. */
.hero { min-height: min(78vh, 40rem); display: grid; align-items: end; padding-block: clamp(4rem, 12vw, 8rem) clamp(2.5rem, 6vw, 4rem); }
.hero:has(.hero__bg:not([hidden])) { padding-block: clamp(6rem, 18vw, 12rem) clamp(2.5rem, 6vw, 4rem); }
.hero__bg::after {
  background: linear-gradient(to top, var(--bg) 2%, color-mix(in srgb, var(--bg) 55%, transparent) 45%, color-mix(in srgb, var(--bg) 25%, transparent) 100%);
}
.hero .lede { max-width: 42ch; }

.figures { border-top: 1px solid var(--line-soft); }
.figures b { color: var(--ink); font-weight: 600; }
.block { border-top: 1px solid var(--line-soft); }
.rows li, .steps li { border-top-color: var(--line-soft); }

/* The fleet, larger. This is the design somebody picks BECAUSE their aircraft
   pictures are good, so the cards get more of the page than anywhere else and
   the picture gets a taller well. */
.cards { grid-template-columns: repeat(auto-fill, minmax(min(19rem, 100%), 1fr)); gap: 1.4rem; }
.card { background: var(--surface); border-color: var(--line-soft); }
/* A deeper shadow than the base card gets, but the same LIFT — how far a thing
   moves when it is pointed at belongs to the motion preset, not to the design. */
.card:hover { box-shadow: var(--shadow-2); }
.card__media { aspect-ratio: 3 / 2; }
.tile { background: var(--surface); border-color: var(--line-soft); }
.wall__tile { border-color: var(--line-soft); }
.band { background: var(--surface); color: var(--ink); border: 1px solid var(--line); }
.band .cta { background: var(--accent); color: var(--on-accent); }
footer { border-top-color: var(--line-soft); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'fleet', 'network', 'hubs', 'wall', 'events', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'quote', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#0c0e13"/>
<rect x="0" y="0" width="160" height="56" fill="#1a2230"/>
<path d="M0 40 L26 26 L48 38 L74 20 L104 36 L132 22 L160 34 L160 56 L0 56 Z" fill="#0f1622"/>
<rect x="0" y="42" width="160" height="14" fill="#0c0e13" opacity=".72"/>
<rect x="10" y="40" width="72" height="9" rx="1" fill="#eef1f6"/>
<rect x="10" y="52" width="8" height="2" rx="1" fill="#4da3ff"/>
<g fill="#14171e" stroke="#1d222b"><rect x="10" y="66" width="42" height="34" rx="4"/><rect x="59" y="66" width="42" height="34" rx="4"/><rect x="108" y="66" width="42" height="34" rx="4"/></g>
<g fill="#232b38"><rect x="14" y="70" width="34" height="17" rx="2"/><rect x="63" y="70" width="34" height="17" rx="2"/><rect x="112" y="70" width="34" height="17" rx="2"/></g>
<g fill="#3a4454"><rect x="14" y="91" width="22" height="3" rx="1.5"/><rect x="63" y="91" width="26" height="3" rx="1.5"/><rect x="112" y="91" width="20" height="3" rx="1.5"/></g>
<g fill="#1d222b"><rect x="10" y="108" width="90" height="3" rx="1.5"/></g>`,
    },

    /* BOARDING PASS — the page as the document the whole hobby is about.
     *
     * Every other design here is a website that belongs to an airline. This one
     * is an artefact the airline issues: a ticket, with a stub, a perforation
     * down the side of it, coupon numbers on the sections and a barcode at the
     * foot. It is the design for a VA whose identity is the flying rather than
     * the branding — the ones who name their Discord channels after gates.
     *
     * The structural idea is the TEAR: main is a card on a tinted ground with a
     * punched notch on each side and a dashed rule between every section, so
     * the page reads as one continuous stub rather than as stacked blocks. That
     * is a different skeleton from anything else in this file, which is the bar
     * for being here at all rather than a recolour of Terminal.
     */
    boardingpass: {
        name: 'Boarding Pass',
        blurb: 'The page as a ticket. Perforations, coupon numbers and a barcode at the foot.',
        tags: ['Light', 'Playful', 'Technical'],
        font: 'technical',
        mode: 'light',
        accent: '#1d4ed8',
        pattern: 'threshold',
        radius: 4,
        motion: 'standard',
        css: `/* Boarding Pass — an artefact, not a brochure. The page is one stub: a card
   on a tinted ground, punched at the sides, torn between every section, with
   the airline's own figures set as the fields on a ticket. */
:root { --measure: 60rem; --gap: clamp(2.4rem, 6vw, 4rem); --motif-opacity: .35; }
body { background: var(--surface-2); }

/* THE STUB.
   main is the ticket. It carries the page's own --bg so the tinted body shows
   around it as the table the ticket is lying on, and it is the only element on
   the page with a shadow — everything inside is flat, because a ticket is. */
main {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  margin-block: clamp(1rem, 3vw, 2rem);
  position: relative;
  /* ROOM FOR THE NOTCHES.
     They are punched into the ticket's edge, which means half of each one is
     OUTSIDE it — so the ticket cannot sit flush against the screen. On a wide
     window the centring gutter already provides that room; on a phone there is
     no gutter, and without this the right-hand notch is drawn past the edge of
     the page. The width is given up rather than a margin set, so the auto
     margins that centre it on a desktop still do. */
  width: calc(100% - 1.8rem);
  margin-inline: auto;
}
/* THE PUNCHED NOTCHES, one per side, at the tear. Two circles of the BODY's
   colour sitting on the ticket's edge — the same trick a real stub uses, and
   the reason the dashed rule below reads as a perforation rather than as a
   dashed border somebody liked. */
main::before, main::after {
  content: ''; position: absolute; top: clamp(11rem, 26vw, 17rem);
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--line);
}
main::before { left: -.8rem; border-right-color: transparent; }
main::after { right: -.8rem; border-left-color: transparent; }

/* NOTHING ESCAPES THE STUB.
   Two things in the block vocabulary run edge to edge by pulling their margins
   out to the window — a hero banner, and any section given a photograph behind
   it. On every other design that is right; here it would put the airline's
   banner outside the ticket it is printed on, hanging over the table. So on
   this design alone they stay inside the card and keep its corner. */
.hero__bg { margin-inline: 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
.bleed { margin-inline: 0; padding-inline: var(--pad); }
.band { margin-inline: var(--pad); }

/* THE TEAR between sections. Dashed, and in the page's own line colour rather
   than the accent, because a perforation is an absence and not a decoration. */
.block, .figures { border-top: 2px dashed var(--line); }
.hero { border-top: 0; }

/* THE FIELD RULE above every heading — and the reason it is a rule and not the
   coupon NUMBER this design obviously wants.
 *
 * The number was written first, as a CSS counter, on the reasoning that drawing
 * it beats typing it: reorder the sections in the editor and the sequence looks
 * after itself. What that missed is that the sections on a page of this site
 * are not fixed at all. A block marked [data-crew-section] is removed at run
 * time when the crew centre has nothing to put in it, so a homepage renders
 * with a different set of sections on a quiet week than on a busy one.
 *
 * On the page, that came out as "Coupon 01" followed by "Coupon 04" — the
 * counter had been computed before two empty sections were taken away and was
 * not recomputed after. A number that skips is worse than no number: it reads
 * as a missing section rather than as a design, which is precisely the
 * complaint a drawn counter exists to prevent.
 *
 * It could have been held together — number them from JavaScript after the feed
 * settles, or stop removing empty sections. Both are a real cost paid so that a
 * decoration can be right. The ticket is already carried by the stub, the
 * notches, the perforations, the field-set figures and the barcode; it did not
 * need a number that can be wrong. So: a short rule in the airline's own
 * accent, which says the same thing about a ticket and cannot count. */
.block__head { position: relative; }
.block__head h2::before {
  content: ''; display: block;
  width: 1.6rem; height: 3px; margin-bottom: .7rem;
  background: var(--accent);
}
h1 { font-weight: 700; letter-spacing: -.04em; text-transform: uppercase; }
h2 { font-size: clamp(1.15rem, 2.4vw, 1.5rem); font-weight: 700; letter-spacing: -.02em; }
.eyebrow { color: var(--accent); font-weight: 500; }

.bar { border-bottom: 2px dashed var(--line); }
.bar__nav a { font-family: var(--font-mono); font-size: .76rem; letter-spacing: .1em; text-transform: uppercase; }

/* THE FIELDS.
   A ticket labels a value ABOVE it in small caps and prints the value large
   underneath. The markup writes the number first, so the label is reordered
   rather than moved — the reading order for a screen reader stays "1,284 hours
   flown" and only the paint order changes. */
.figures { gap: 1.2rem 2rem; }
.figures > div { border-bottom: 1px solid var(--line); padding-bottom: .5rem; }
.figures b { order: 2; font-size: clamp(1.6rem, 4vw, 2.4rem); color: var(--accent); letter-spacing: -.03em; }
.figures span {
  order: 1; font-family: var(--font-mono); font-size: .62rem;
  letter-spacing: .18em; text-transform: uppercase; color: var(--faint);
}

.rows li, .steps li { border-top: 1px dashed var(--line-soft); padding: .7rem 0; }
.rows li:last-child, .steps li:last-child { border-bottom: 1px dashed var(--line-soft); }
.rows li b { font-family: var(--font-mono); letter-spacing: .02em; }
.tile .code, .pill, .card__body b { font-family: var(--font-mono); }
.card, .tile { background: none; border-style: dashed; }
.card__media { background: var(--surface); border-bottom: 1px dashed var(--line); }
.cta { font-family: var(--font-mono); letter-spacing: .1em; text-transform: uppercase; font-size: .8rem; }

.band { border: 2px dashed var(--on-accent); border-radius: var(--radius); }

/* THE BARCODE. Pure gradient, so it costs no request and cannot 404 — and
   deliberately not a real one: a scannable code on a virtual airline's website
   would be a promise of something that is not there. It is the mark at the end
   of a ticket, which is all it is pretending to be. */
footer { border-top: 2px dashed var(--line); position: relative; }
footer::before {
  content: ''; display: block; height: 2.6rem;
  max-width: var(--measure); margin: 1.6rem auto -.6rem;
  background-image: repeating-linear-gradient(90deg,
    var(--ink) 0 2px, transparent 2px 5px, var(--ink) 5px 6px, transparent 6px 11px,
    var(--ink) 11px 14px, transparent 14px 16px, var(--ink) 16px 17px, transparent 17px 22px);
  opacity: .5;
}
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'hubs', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#eef1f6"/>
<rect x="8" y="6" width="144" height="108" rx="6" fill="#fff" stroke="#d8dee8"/>
<circle cx="8" cy="52" r="6" fill="#eef1f6" stroke="#d8dee8"/>
<circle cx="152" cy="52" r="6" fill="#eef1f6" stroke="#d8dee8"/>
<rect x="18" y="16" width="58" height="8" rx="1" fill="#20242c"/>
<rect x="18" y="29" width="34" height="3" rx="1" fill="#1d4ed8"/>
<g stroke="#d8dee8" stroke-width="1.5" stroke-dasharray="4 3"><path d="M8 52 H152"/><path d="M8 84 H152"/></g>
<g fill="#9aa4b3"><rect x="18" y="59" width="14" height="3"/><rect x="54" y="59" width="14" height="3"/><rect x="90" y="59" width="14" height="3"/><rect x="126" y="59" width="12" height="3"/></g>
<g fill="#1d4ed8"><rect x="18" y="65" width="20" height="9" rx="1"/><rect x="54" y="65" width="20" height="9" rx="1"/><rect x="90" y="65" width="20" height="9" rx="1"/><rect x="126" y="65" width="16" height="9" rx="1"/></g>
<g fill="#20242c" opacity=".45"><rect x="18" y="94" width="2" height="14"/><rect x="23" y="94" width="1" height="14"/><rect x="27" y="94" width="3" height="14"/><rect x="33" y="94" width="1" height="14"/><rect x="37" y="94" width="2" height="14"/><rect x="43" y="94" width="3" height="14"/><rect x="49" y="94" width="1" height="14"/><rect x="53" y="94" width="2" height="14"/><rect x="58" y="94" width="1" height="14"/><rect x="62" y="94" width="3" height="14"/><rect x="68" y="94" width="1" height="14"/><rect x="72" y="94" width="2" height="14"/><rect x="77" y="94" width="3" height="14"/><rect x="83" y="94" width="1" height="14"/><rect x="87" y="94" width="2" height="14"/><rect x="92" y="94" width="1" height="14"/><rect x="96" y="94" width="3" height="14"/><rect x="102" y="94" width="1" height="14"/><rect x="106" y="94" width="2" height="14"/><rect x="111" y="94" width="3" height="14"/><rect x="117" y="94" width="1" height="14"/><rect x="121" y="94" width="2" height="14"/><rect x="126" y="94" width="1" height="14"/><rect x="130" y="94" width="3" height="14"/><rect x="136" y="94" width="1" height="14"/><rect x="140" y="94" width="2" height="14"/></g>`,
    },

    /* FLIGHT DECK — the airline as the instruments rather than as the brochure.
     *
     * Dark like Concourse and nothing like it. Concourse is a departure board:
     * flat rows of amber on black, read from thirty feet away by somebody who
     * wants a gate number. This is the panel in front of the pilot — every
     * section is a boxed instrument with corner brackets, the figures sit in
     * bracketed tape readouts, and the headings are FMA annunciations rather
     * than words.
     *
     * The corner brackets are the reason this is a design and not a palette.
     * They are eight gradients on a single pseudo-element, so a section becomes
     * an instrument without a line of extra markup — and they sit on ::after
     * because ::before on a block already belongs to the motif layer.
     */
    flightdeck: {
        name: 'Flight Deck',
        blurb: 'A glass cockpit. Bracketed panels, tape readouts and annunciator headings on near-black.',
        tags: ['Dark', 'Technical', 'Bold'],
        font: 'technical',
        mode: 'dark',
        accent: '#32e0c8',
        pattern: 'grid',
        radius: 3,
        motion: 'subtle',
        css: `/* Flight Deck — instruments. Every section is a panel with its corners ticked,
   every heading is an annunciation, and the accent is used the way a PFD uses
   green: for the live values and for nothing else. */
:root { --measure: 68rem; --gap: clamp(2.2rem, 5vw, 3.4rem); --motif-opacity: .35; }
body { font-size: 15px; letter-spacing: .005em; }
h1 { font-weight: 700; letter-spacing: -.035em; text-transform: uppercase; }

/* THE ANNUNCIATION. A heading on a flight deck is a short word in a lit box,
   not a sentence — so an h2 here is boxed, tracked out and small, and the
   sentence that would have been the heading is the line underneath it. */
h2 {
  display: inline-block; margin-bottom: 1rem;
  padding: .3rem .6rem;
  font-family: var(--font-mono); font-size: .7rem; font-weight: 700;
  letter-spacing: .2em; text-transform: uppercase;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid var(--accent-line); border-radius: var(--radius-sm);
}
.block__head p { font-family: var(--font-mono); font-size: .78rem; letter-spacing: .04em; }
.eyebrow { color: var(--accent); }

.bar { border-bottom: 1px solid var(--line); font-family: var(--font-mono); }
.bar__nav a { font-family: var(--font-mono); font-size: .74rem; letter-spacing: .12em; text-transform: uppercase; }

/* THE PANEL, AND ITS CORNER BRACKETS.

   Eight gradients on one pseudo-element: a short horizontal and a short
   vertical at each of the four corners. This is the whole reason the design
   needs no markup of its own — a section becomes an instrument by having a
   ::after, and the brackets scale with the box because each one is positioned
   to a corner rather than offset from an origin.

   ::after, not ::before: [data-motif]::before is the airline's own pattern and
   the 'values' block carries data-motif. Two decorations on one pseudo-element
   is one of them not rendering. */
.block {
  position: relative;
  border: 1px solid var(--line);
  padding: clamp(1.3rem, 3.4vw, 2rem);
  margin-bottom: 1rem;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.block::after {
  content: ''; position: absolute; inset: -1px; pointer-events: none;
  background-image:
    linear-gradient(var(--accent), var(--accent)), linear-gradient(var(--accent), var(--accent)),
    linear-gradient(var(--accent), var(--accent)), linear-gradient(var(--accent), var(--accent)),
    linear-gradient(var(--accent), var(--accent)), linear-gradient(var(--accent), var(--accent)),
    linear-gradient(var(--accent), var(--accent)), linear-gradient(var(--accent), var(--accent));
  background-repeat: no-repeat;
  background-size: 14px 1px, 1px 14px, 14px 1px, 1px 14px, 14px 1px, 1px 14px, 14px 1px, 1px 14px;
  background-position: 0 0, 0 0, 100% 0, 100% 0, 0 100%, 0 100%, 100% 100%, 100% 100%;
}
/* Where color-mix is missing the panel loses its wash and keeps its rule, which
   is the same instrument with less glass. */
@supports not (background: color-mix(in srgb, red 50%, transparent)) {
  .block { background: none; }
}

/* THE TAPE READOUT. A value on a PFD is bracketed, right up against its own
   edges, in a box that is obviously a window onto something moving. */
.figures { gap: .9rem; }
.figures > div {
  border: 1px solid var(--line); border-left: 2px solid var(--accent);
  padding: .7rem .85rem; background: var(--surface);
}
.figures b { font-family: var(--font-mono); font-size: clamp(1.5rem, 3.6vw, 2.2rem); color: var(--accent); letter-spacing: -.03em; }
.figures span { font-family: var(--font-mono); font-size: .64rem; letter-spacing: .16em; text-transform: uppercase; }
/* A value on its way to itself is the one moving thing on an instrument panel,
   so it is the one thing allowed to glow. */
.figures b[data-counting] { text-shadow: 0 0 14px color-mix(in srgb, var(--accent) 55%, transparent); }

.rows li, .steps li { padding: .5rem 0; font-family: var(--font-mono); font-size: .82rem; border-top-color: var(--line-soft); }
.rows li b { color: var(--accent); }
.rows span, .steps span { font-family: var(--font-body); }
.card, .tile { background: var(--surface); border-color: var(--line); }
.card__body b, .tile .code, .pill { font-family: var(--font-mono); }
.cta {
  font-family: var(--font-mono); font-size: .78rem;
  letter-spacing: .14em; text-transform: uppercase;
}
.cta--ghost { border-color: var(--accent-line); color: var(--accent); }
.band {
  background: var(--surface); color: var(--ink);
  border: 1px solid var(--accent-line); border-top: 2px solid var(--accent);
}
/* The apply band gets its heading back.
   An annunciation is a WORD in a lit box — "WHERE WE FLY" is one, and it is why
   every other heading on this design is tracked out and boxed. The band's
   heading is a whole sentence, and a sentence in an annunciator chip stops
   reading as an instrument and starts reading as a mistake. */
.band h2 {
  display: block; padding: 0; background: none; border: 0;
  font-family: var(--font-display); font-size: clamp(1.3rem, 3vw, 1.9rem);
  font-weight: 700; letter-spacing: -.03em; text-transform: none;
  color: inherit;
}
.band .cta { background: var(--accent); color: #07110f; }
footer { border-top: 1px solid var(--line); font-family: var(--font-mono); font-size: .78rem; }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'activity', 'network', 'hubs', 'notices', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'staff', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#0a0d11"/>
<rect x="0" y="0" width="160" height="12" fill="#111720"/>
<g stroke="#1a2430" stroke-width="1"><path d="M0 26 H160 M0 46 H160 M0 66 H160 M0 86 H160 M20 12 V120 M50 12 V120 M80 12 V120 M110 12 V120 M140 12 V120"/></g>
<rect x="10" y="19" width="62" height="8" rx="1" fill="#e8eef2"/>
<g fill="#32e0c8"><rect x="10" y="34" width="24" height="5" rx="1"/></g>
<g fill="#0f1720" stroke="#1e2833"><rect x="10" y="46" width="32" height="22"/><rect x="46" y="46" width="32" height="22"/><rect x="82" y="46" width="32" height="22"/><rect x="118" y="46" width="32" height="22"/></g>
<g fill="#32e0c8"><rect x="10" y="46" width="2" height="22"/><rect x="46" y="46" width="2" height="22"/><rect x="82" y="46" width="2" height="22"/><rect x="118" y="46" width="2" height="22"/><rect x="16" y="54" width="18" height="7" rx="1"/><rect x="52" y="54" width="18" height="7" rx="1"/><rect x="88" y="54" width="18" height="7" rx="1"/><rect x="124" y="54" width="16" height="7" rx="1"/></g>
<rect x="10" y="78" width="140" height="34" fill="none" stroke="#1e2833"/>
<g fill="#32e0c8"><rect x="10" y="78" width="11" height="1"/><rect x="10" y="78" width="1" height="11"/><rect x="139" y="78" width="11" height="1"/><rect x="149" y="78" width="1" height="11"/><rect x="10" y="111" width="11" height="1"/><rect x="10" y="101" width="1" height="11"/><rect x="139" y="111" width="11" height="1"/><rect x="149" y="101" width="1" height="11"/></g>
<rect x="18" y="85" width="26" height="6" rx="1" fill="#14342f" stroke="#1f5c52"/>
<g fill="#26313d"><rect x="18" y="97" width="120" height="3"/><rect x="18" y="104" width="92" height="3"/></g>`,
    },

    /* ATLAS — the airline as its network.
     *
     * The structural idea is a ROUTE DOWN THE PAGE: a dotted line running the
     * whole left margin with a waypoint ring at every heading, so scrolling the
     * site is flying the sectors in order. No other design here has a spine —
     * they are all stacks — and a spine changes how the page is read rather
     * than how it is coloured.
     *
     * The accent is chart magenta because that is the colour controlled
     * airspace is printed in on every VFR sectional in the world. It is the one
     * accent in this file that means something before anybody picks it.
     */
    atlas: {
        name: 'Atlas',
        blurb: 'Map-led. A route line down the page with a waypoint at every section, on chart paper.',
        tags: ['Light', 'Editorial', 'Network'],
        font: 'grotesk',
        mode: 'light',
        accent: '#b4327a',
        pattern: 'radar',
        radius: 10,
        motion: 'standard',
        css: `/* Atlas — the network as the layout. A dotted track down the left margin, a
   waypoint ring at every heading, and a great circle behind the headline. */
:root { --measure: 64rem; --gap: clamp(3rem, 7vw, 5rem); --motif-opacity: .5; }
h1 { font-weight: 500; letter-spacing: -.04em; }
h2 { font-weight: 600; letter-spacing: -.025em; }
.eyebrow { color: var(--accent); }

/* THE GREAT CIRCLE.
   A route on a chart is an arc, not a line. This is one: a box far wider than
   the hero, rounded to an ellipse, showing only its top edge — so what crosses
   behind the headline is a shallow curve rather than a circle somebody drew.
   Dashed, in the accent's own line colour, and behind everything. */
/* THE GREAT CIRCLE THAT IS NOT HERE.
 *
 * A dashed arc swept behind the headline, because a route on a chart is an arc
 * and not a line. It was drawn, and it is gone, and both halves are worth
 * writing down.
 *
 * It failed on legibility first. The hero's words fill the left of the section
 * top to bottom, so an arc crossing the hero crosses the sentence — on the page
 * it ran straight through "Write the sentence here that says what your airline
 * is for", and a decoration that strikes through a paragraph is not a
 * decoration. Lowering it put it through the buttons; raising it put it through
 * the headline. There was no height at which it was behind the words rather
 * than across them.
 *
 * And it failed on restraint second, which is the more useful lesson: this
 * design already ships the Radar motif, which is concentric arcs. Two systems
 * of curved lines in one section is not twice the idea, it is a smudge — the
 * same reason the base stylesheet takes the motif away from a hero that has a
 * photograph in it.
 *
 * What makes Atlas itself is the track down the page and the waypoint at every
 * heading. Those are structure. The arc was a third thing in a space that
 * already had two.
 */

/* THE TRACK.

   ONE line down the whole page, drawn on main — not a piece of line per
   section. A track assembled out of per-section segments breaks wherever a
   section cannot carry one, and .figures is exactly that case: it is a grid, so
   a pseudo-element on it becomes a grid item and lands in the layout as an
   empty cell rather than behind it as a line. Drawing it once on the page's
   container sidesteps the whole question and is the only way the route is
   continuous from the headline to the footer.

   Only from about 38rem up. On a phone the margin it needs is a quarter of the
   screen, and a decoration costing a quarter of the reading width on the device
   most visitors arrive on is not a decoration.

   --track is the one number: the page's left padding grows by it, the line
   sits at half of it, and the waypoint is centred on the line. Three things
   that must agree, derived rather than typed out three times. */
.block__head { position: relative; }
@media (min-width: 38rem) {
  :root { --track: 2.4rem; }
  /* The SECTIONS move over, not main. Padding main itself would have been
     fewer lines and would have quietly broken every full-bleed section on the
     page: a bleed reaches the window by measuring 50% of the box it sits in,
     and moving that box's content edge without telling it leaves the picture
     hanging off one side. main keeps its own geometry; the route is drawn in
     the margin the sections give up. */
  main { position: relative; }
  .hero, .figures, .block { padding-left: var(--track); }
  main::after {
    content: ''; position: absolute; pointer-events: none;
    left: calc(var(--pad) + var(--track) / 2); top: 0; bottom: 0; width: 1px;
    background-image: linear-gradient(to bottom, var(--line) 0 4px, transparent 4px 10px);
    background-size: 1px 10px;
  }
  /* THE WAYPOINT. A ring, not a dot: an unfilled circle is how a reporting
     point is drawn on a chart and a filled one is how a city is — and this is
     a heading rather than a destination.

     z-index, because both this and the track are positioned descendants of the
     same box and the track is main's LAST child, so without it the line paints
     over the ring. The ring's own background is what punches the track open
     and makes the route read as passing through the waypoint. */
  .block__head::after {
    content: ''; position: absolute; z-index: 1; top: .42em;
    left: calc(var(--track) / -2 - .5rem);
    width: .75rem; height: .75rem;
    border: 2px solid var(--accent); border-radius: 50%;
    background: var(--bg);
  }
}

.figures b { color: var(--accent); font-weight: 500; }
.figures span { font-size: .84rem; letter-spacing: .01em; }

/* A SECTOR LIST IS THE POINT OF THIS DESIGN, so it gets the one flourish: the
   arrow between two airports is the airline's own accent, and the row lifts a
   fraction of the page's own colour when it is pointed at. */
.rows li { border-top-color: var(--line-soft); transition: background-color .15s ease; }
.rows li b { color: var(--accent); letter-spacing: -.01em; }
.rows li:hover { background: var(--accent-soft); }
.steps li { border-top-color: var(--line-soft); }

.card, .tile { border-color: var(--line-soft); box-shadow: var(--shadow-1); }
.tile .code { letter-spacing: .04em; }
.pill { border-color: var(--accent-line); }
.quote p { max-width: 30ch; }
/* THE ROUTE ENDS AT THE BAND.
   The track is drawn down the whole of main, and the apply band is the last
   thing in it — so without this the dotted line carries on over a block of
   solid accent, which reads as a line drawn on top of the artwork rather than
   as a route the page follows. Painting the band over it stops the route where
   the page stops being a journey and starts being an invitation. */
.band { border-radius: var(--radius-lg); position: relative; z-index: 1; }
footer { border-top: 1px dashed var(--line); }
`,
        pages: [
            { path: 'index.html', title: null, blocks: ['hero', 'figures', 'network', 'hubs', 'partners', 'activity', 'events', 'wall', 'cta'] },
            { path: 'fleet.html', title: 'Fleet', blocks: ['fleet', 'ranks', 'cta'] },
            { path: 'join.html', title: 'Join', blocks: ['joining', 'values', 'quote', 'contact'] },
        ],
        thumb: `<rect width="160" height="120" fill="#fdfbfd"/>
<rect x="0" y="0" width="160" height="13" fill="#fff"/>
<rect x="0" y="13" width="160" height="1" fill="#ecdfe8"/>
<path d="M-10 44 Q80 16 170 44" fill="none" stroke="#e7bcd6" stroke-width="1" stroke-dasharray="4 3"/>
<rect x="12" y="24" width="76" height="9" rx="2" fill="#241d22"/>
<rect x="12" y="38" width="48" height="4" rx="2" fill="#b4327a"/>
<g stroke="#e2d6de" stroke-width="1" stroke-dasharray="3 5"><path d="M22 56 V114"/></g>
<g fill="#fdfbfd" stroke="#b4327a" stroke-width="2"><circle cx="22" cy="60" r="3.5"/><circle cx="22" cy="88" r="3.5"/></g>
<rect x="34" y="56" width="44" height="7" rx="1" fill="#241d22"/>
<g fill="#b4327a"><rect x="34" y="69" width="22" height="4" rx="1"/><rect x="34" y="77" width="22" height="4" rx="1"/></g>
<g fill="#ded2da"><rect x="62" y="69" width="52" height="4" rx="1"/><rect x="62" y="77" width="44" height="4" rx="1"/></g>
<rect x="34" y="84" width="36" height="7" rx="1" fill="#241d22"/>
<g fill="#f0e7ed"><rect x="34" y="97" width="34" height="16" rx="3"/><rect x="72" y="97" width="34" height="16" rx="3"/><rect x="110" y="97" width="34" height="16" rx="3"/></g>`,
    },
};

const DEFAULT_TEMPLATE = 'flightline';

/* ===========================================================================
 * THEME
 *
 * One small file of custom properties, and the only thing the theme picker
 * writes. Every template's CSS reads through these, so changing an accent is
 * one file and no search-and-replace.
 *
 * --on-accent is derived rather than assumed white: Livery puts body text on a
 * block of the accent, and a VA who picks a pale yellow would otherwise get a
 * page of invisible words.
 * ======================================================================== */

/** Perceived luminance, for deciding what to put ON a colour.
 *  Rec. 601 — close enough for "is this dark", and cheap. Kept because other
 *  things read it; what goes on the accent is decided by contrast, below. */
function luminance(hexColor) {
    let h = String(hexColor).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** WCAG relative luminance. Gamma-corrected, unlike the cheap one above. */
function relativeLuminance(hexColor) {
    let h = String(hexColor).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const contrast = (a, b) => {
    const l1 = relativeLuminance(a), l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const INK_ON_ACCENT = '#16181d';

/**
 * What text on a block of the accent should be.
 *
 * Whichever of white and near-black is EASIER TO READ on it, measured — not
 * whichever side of a brightness threshold the colour falls on. The threshold
 * version got the two ends right and the middle wrong: a mid-tone blue like
 * #4da3ff sat just under it and was given white text at about 2.6:1, which is
 * a button whose label you have to lean in to read. The same colour scores
 * 6.9:1 with dark text. Nothing here is a taste; one of the two is measurably
 * legible and the other is not.
 */
function onAccentFor(accent) {
    return contrast(accent, '#ffffff') >= contrast(accent, INK_ON_ACCENT)
        ? '#ffffff' : INK_ON_ACCENT;
}

/** A corner radius, or the fallback. null, '' and undefined all mean "not
 *  chosen" and must not collapse to 0 the way Number() would have them. */
function radiusOf(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(28, Math.round(n))) : fallback;
}

function normaliseTheme(raw, template) {
    const t = TEMPLATES[template] || TEMPLATES[DEFAULT_TEMPLATE];
    const o = (raw && typeof raw === 'object') ? raw : {};
    return {
        accent: hex(o.accent, t.accent),
        font: FONTS[o.font] ? o.font : t.font,
        mode: MODES[o.mode] ? o.mode : t.mode,
        // The template's own motif is the default rather than `none`, so that
        // picking a design gets the design its author drew — pattern included —
        // and a VA who wants a bare page chooses that on purpose.
        pattern: PATTERNS[o.pattern] ? o.pattern : (t.pattern || DEFAULT_PATTERN),
        // Corner softness, as one number a VA moves rather than five they
        // cannot see the relationship between. Everything round on the site is
        // derived from it below.
        //
        // ABSENT IS NOT ZERO, and the difference matters: a site stored before
        // this field existed reads back as null, and Number(null) is 0 — which
        // would silently square off every corner on every site that had never
        // been asked. So absence is tested before the number is.
        radius: radiusOf(o.radius, radiusOf(t.radius, 12)),
        // How much the site moves. Falls back to the design's own answer and
        // then to Standard, so a site stored before motion existed opens on the
        // behaviour it already had rather than on silence — Skyline is meant to
        // be cinematic and Terminal is meant to sit still, and neither of those
        // is a preference anybody typed.
        motion: MOTION[o.motion] ? o.motion : (MOTION[t.motion] ? t.motion : DEFAULT_MOTION),
    };
}

/* One motif, as the two or three declarations a background needs. Written into
 * theme.css as custom properties so a template can move it, scale it or turn it
 * off in one line without knowing which motif it is looking at. */
function renderPatternCss(pattern) {
    const p = PATTERNS[pattern] || PATTERNS[DEFAULT_PATTERN];
    return [
        `  --motif-image: ${p.image};`,
        `  --motif-size: ${p.size};`,
        `  --motif-position: ${p.position || '0 0'};`,
    ].join('\n');
}

/* One motion preset, as the properties every animated rule reads through. */
function renderMotionCss(motion) {
    const m = MOTION[motion] || MOTION[DEFAULT_MOTION];
    const t = m.tokens;
    return [
        `  --motion: ${MOTION[motion] ? motion : DEFAULT_MOTION};`,
        `  --motion-count: ${m.count ? 1 : 0};`,
        `  --motion-in: ${t.in};`,
        `  --motion-ease: ${t.ease};`,
        `  --motion-rise: ${t.rise};`,
        `  --motion-scale: ${t.scale};`,
        `  --motion-blur: ${t.blur};`,
        `  --motion-stagger: ${t.stagger};`,
        `  --motion-hover: ${t.hover};`,
    ].join('\n');
}

function renderThemeCss(theme) {
    /* Defaulted here as well as in normaliseTheme, because this is an EXPORT: a
     * caller with a stored theme from before motifs existed, or a test handing
     * over the three fields it cares about, must get a stylesheet rather than a
     * crash. A missing field is the old behaviour, which is a design with no
     * motif and the middling corner. */
    const t = theme || {};
    const f = FONTS[t.font] || FONTS[TEMPLATES[DEFAULT_TEMPLATE].font];
    const accent = hex(t.accent, TEMPLATES[DEFAULT_TEMPLATE].accent);
    const mode = MODES[t.mode] ? t.mode : 'auto';
    const pattern = PATTERNS[t.pattern] ? t.pattern : DEFAULT_PATTERN;
    const r = radiusOf(t.radius, 12);
    const motion = MOTION[t.motion] ? t.motion : DEFAULT_MOTION;
    theme = { accent: accent, font: FONTS[t.font] ? t.font : TEMPLATES[DEFAULT_TEMPLATE].font, mode: mode, pattern: pattern, radius: r, motion: motion };
    const onAccent = onAccentFor(theme.accent);

    /* THE TWO PALETTES.
     *
     * Five tokens became nine, and each of the four is here because a design
     * kept faking it: --surface-2 for a panel inside a panel, --line-soft for a
     * rule that separates rows rather than sections, --faint for a caption that
     * must not compete with --muted, and --accent-soft for a tint of the accent
     * to sit BEHIND text rather than under it.
     *
     * --accent-soft is mixed from the VA's own accent at run time rather than
     * written as a fixed colour, so it is right for every accent instead of
     * right for the one this file was written against.
     */
    const light = [
        `  --bg: #ffffff;`,
        `  --surface: #f7f8fb;`,
        `  --surface-2: #eef1f6;`,
        `  --ink: #14161b;`,
        `  --muted: #59616e;`,
        `  --faint: #8b94a3;`,
        `  --line: #e3e7ee;`,
        `  --line-soft: #eef1f5;`,
        `  --shadow-1: 0 1px 2px rgba(16, 20, 28, .05), 0 1px 3px rgba(16, 20, 28, .05);`,
        `  --shadow-2: 0 10px 30px -12px rgba(16, 20, 28, .22), 0 2px 6px rgba(16, 20, 28, .05);`,
    ].join('\n');
    const dark = [
        `  --bg: #0c0e13;`,
        `  --surface: #14171e;`,
        `  --surface-2: #1b1f28;`,
        `  --ink: #eef1f6;`,
        `  --muted: #9aa4b3;`,
        `  --faint: #6c7684;`,
        `  --line: #262b35;`,
        `  --line-soft: #1d222b;`,
        `  --shadow-1: 0 1px 2px rgba(0, 0, 0, .4);`,
        `  --shadow-2: 0 14px 34px -14px rgba(0, 0, 0, .7), 0 2px 8px rgba(0, 0, 0, .35);`,
    ].join('\n');

    let palette;
    if (theme.mode === 'dark') {
        palette = `:root {\n${dark}\n}`;
    } else if (theme.mode === 'light') {
        palette = `:root {\n${light}\n}`;
    } else {
        palette = `:root {\n${light}\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n${dark.replace(/^ {2}/gm, '    ')}\n  }\n}`;
    }

    return `/* theme.css — the colours, the type, the corners and the motif for this
   whole site. Change a value here and every page follows.

   The Website tab's design controls rewrite this file, so if you edit it by
   hand, expect the picker to overwrite your changes next time somebody uses it.
   Anything you want to keep belongs in style.css, which the picker never
   touches.

   Accent: ${theme.accent}   Type: ${FONTS[theme.font].label}   Mode: ${MODES[theme.mode].label}
   Motif: ${PATTERNS[theme.pattern].label}   Corners: ${r}px   Motion: ${MOTION[theme.motion].label} */

@import url('https://fonts.googleapis.com/css2?family=${f.google}&display=swap');

:root {
  --accent: ${theme.accent};
  /* What text on a block of the accent should be. Worked out from the accent's
     own brightness, so a pale accent gets dark text rather than white on white. */
  --on-accent: ${onAccent};
  /* A wash of the accent, for a tint UNDER text — a badge, a hovered row, the
     lead card in a grid. Mixed from the accent rather than fixed, so it is
     correct for whatever accent this airline picked. */
  --accent-soft: color-mix(in srgb, var(--accent) 12%, var(--bg));
  --accent-line: color-mix(in srgb, var(--accent) 32%, var(--line));

  --font-display: ${f.display};
  --font-body: ${f.body};
  --font-mono: ${f.mono};

  /* SHAPE. One number in the picker, four here. A card, a button and a badge
     rounded by the same absolute radius do not look like the same family — the
     small element reads as a pill and the large one as barely rounded — so the
     small ones are capped and the large one is scaled. */
  --radius: ${r}px;
  --radius-sm: ${Math.max(0, Math.round(r * 0.55))}px;
  --radius-lg: ${Math.round(r * 1.5)}px;
  --radius-pill: 999px;

  /* THE MOTIF, drawn in gradients. See PATTERNS in vaSiteTemplates.js for why
     it is currentColor and not a colour: the same declaration has to work
     behind dark text on the page and light text on the accent. */
${renderPatternCss(theme.pattern)}

  /* HOW MUCH THIS SITE MOVES.

     Every animated rule in style.css reads through these and none of them names
     a number of its own, so the whole of "how does this site feel" is the eight
     lines below. See MOTION in vaSiteTemplates.js for why they are one preset
     rather than eight controls.

     --motion is the preset's NAME and is the only one site.js reads: the
     distances belong to the stylesheet, and the script's one question is
     whether anything moves at all. --motion-count is the same question for the
     figures, which are script rather than stylesheet.

     A visitor whose system asks for less movement overrides all of this. That
     is enforced in style.css and again in site.js, not here. */
${renderMotionCss(theme.motion)}

  /* Spacing and measure. A template overrides these in style.css. */
  --pad: clamp(1.15rem, 5vw, 3rem);
  --measure: 64rem;
  --gap: clamp(3rem, 7vw, 5rem);

  color-scheme: ${theme.mode === 'auto' ? 'light dark' : theme.mode};
}

${palette}
`;
}

/* ===========================================================================
 * RENDERING
 * ======================================================================== */

function pageHtml(tpl, page, ctx) {
    const title = page.title ? `${page.title} — ${ctx.name}` : ctx.name;
    const body = page.blocks.map((id) => {
        const block = BLOCKS[id];
        return block ? block(ctx) : `  <!-- unknown block: ${esc(id)} -->`;
    }).join('\n');

    // nav and footer are outside <main> on every page and are not composable
    // blocks, because a page has exactly one of each.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(ctx.name)} — a virtual airline on Infinite Flight.">
<link rel="stylesheet" href="theme.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
${BLOCKS.nav(ctx)}

<main>
${body}
</main>

${BLOCKS.footer(ctx)}

<!-- The feed, then your site's own script. crew-feed.js reads your crew centre
     and fills in everything marked data-crew-*; site.js hangs the Instagram
     wall and clears away a section that turned out to be empty. No key in
     either, and every endpoint they read is public. -->
<script src="${ctx.feedSrc}" data-va="${esc(ctx.slug)}" data-auto="off"></script>
<script src="site.js"></script>
</body>
</html>
`;
}

function readme(tpl, ctx) {
    return `# ${ctx.name} — your website

Design: **${tpl.name}**. ${tpl.blurb}

## The files

${tpl.pages.map(p => `- \`${p.path}\` — ${p.title || 'the homepage'}`).join('\n')}
- \`theme.css\` — colours and type. The theme controls in the Website tab rewrite this.
- \`style.css\` — the layout and personality of this design.
- \`site.js\` — hangs the Instagram wall and removes a section with nothing in it.

Add a page in the editor. \`index.html\` is what a visitor gets at \`/\`, and a
folder's \`index.html\` is what they get at that folder.

## Where the numbers come from

Every page loads \`crew-feed.js\` with your airline's address. It fills in
anything marked up with \`data-crew-*\`:

- \`<b data-crew-stat="pilots">\` — a figure. Wrap it and its label in
  \`data-crew-figure\` and the whole block goes when the figure does not arrive,
  rather than leaving a dash next to a label.
- \`<ul data-crew-list="routes">\` with a \`<template>\` inside — a list, one
  copy of the template per row. Lists: \`routes\`, \`events\`, \`schedule\`,
  \`notices\`, \`activity\`, \`posts\`.
- \`data-crew-limit\` caps the rows. \`data-crew-written="on"\` narrows
  \`notices\` to what a person actually typed.
- \`<img data-crew-brand="logo">\` — your identity. \`logo\`, \`banner\`,
  \`name\`, \`tagline\`, \`code\`. On an image it fills the \`src\`; on
  anything else it fills the text. **A field you have not set removes the
  element** rather than leaving a broken image, so wrap one in
  \`data-crew-figure\` when the frame around it should go too.

## What is already yours, without typing it again

Your **logo** and **banner** are the ones on your Inflight VA profile. Your
**rank ladder** and your **fleet** are the ones in your crew centre. Change any
of them there and this site follows — there is nothing to re-upload and nothing
to keep in step by hand.

The lists that read from your crew centre: \`routes\`, \`events\`,
\`schedule\`, \`notices\`, \`activity\`, \`posts\`, \`ranks\`,
\`fleet\`, \`roles\`, \`hubs\`, \`partners\`.

\`hubs\` and \`partners\` are worked out from your route map rather than typed
anywhere — the airports you fly most out of, and the airlines you codeshare
with. Publish a sector and they follow.

### Putting a picture behind a section

Any section can carry one. In the builder it is under **Picture behind this
section**; by hand it is a class and a layer:

\`\`\`html
<section class="block has-bg" style="--dim:.55;--bg-pos:50% 50%">
  <span class="has-bg__layer" aria-hidden="true">
    <img src="https://…" alt="" loading="lazy" decoding="async">
  </span>
  …
</section>
\`\`\`

Add \`bleed\` beside \`has-bg\` to run it edge to edge. \`--dim\` is how dark the
scrim over it is, and there is always one: white words over a photograph nobody
checked them against are unreadable often enough to be a rule.

### Your fleet always has a picture

Every aircraft in the fleet list gets an image. Yours if you uploaded a livery
shot; otherwise an outline we draw for the type, which needs no request and
cannot fail to load. \`{{credit}}\` says where a picture came from — nothing at
all for one of your own, and our name on one of ours. Leave it in the markup:
a picture on a website belongs to whoever made it.

**Write a true fallback inside the markup.** If the crew centre is unreachable
the page keeps what you wrote — it never goes blank because a request timed out.
That is why every list in this template ships with a real row already in it.

Reading the feed yourself works too: \`await CrewFeed.routes()\`,
\`CrewFeed.stats()\`, \`CrewFeed.posts()\`. Each resolves to \`null\` rather
than throwing, and \`null\` means "leave the page alone".

## Changing how it looks

Almost everything is a variable in \`theme.css\`. Change \`--accent\` and the
buttons, links and figures all follow. Use the design controls in the Website tab
and it will be rewritten for you.

Five things live there: the **accent**, the **type**, **light or dark**, and two
that are about your airline rather than about taste —

- **\`--radius\`**, one number for how soft the corners are. \`--radius-sm\` and
  \`--radius-lg\` are worked out from it, so a badge and a card stay a family.
- **the motif** — \`--motif-image\`, \`--motif-size\`, \`--motif-position\`. Your
  airline's own pattern, drawn in gradients, hung behind anything marked
  \`data-motif\` (the hero, the apply band). It is mixed from \`currentColor\`, so
  the one definition works behind dark text on the page and light text on a
  block of your accent. Two airlines both in navy are still nothing alike; this
  is the part of that a colour picker cannot reach.

— and the fifth, **motion**.

## How much the site moves

One choice — Still, Subtle, Standard, Expressive or Cinematic — and it sets the
whole of \`--motion-*\` in \`theme.css\`. Every animated rule in \`style.css\`
reads through those and none of them names a duration of its own, so this is the
only place movement is decided:

| | |
|---|---|
| \`--motion-in\` | how long an arrival takes |
| \`--motion-ease\` | the curve it takes. Expressive's overshoots on purpose |
| \`--motion-rise\` | how far a section travels to get there |
| \`--motion-scale\` | what size it starts at. Cinematic starts *larger* — a camera pushing in |
| \`--motion-blur\` | how soft it starts |
| \`--motion-stagger\` | the gap between one row of a list and the next |
| \`--motion-hover\` | how far a card lifts when it is pointed at |

Change one and the site follows. Set \`--motion-stagger\` to \`0ms\` and lists
arrive all at once; raise \`--motion-rise\` and everything travels further.

Two presets also count the live figures **up** to their values rather than
printing them. That is \`--motion-count: 1\`, and it only ever counts to the
number your crew centre actually sent — a figure that has not arrived, or that
is not a plain number, is left exactly as your markup has it.

**Nothing here overrules the visitor.** Anybody whose device asks for reduced
motion gets a completely still page whichever preset you picked, and a page with
its JavaScript blocked is complete and correct before a line of it runs — no
section on this site is ever hidden by the stylesheet alone.

## Changing the design

The Website tab's design picker swaps the layout and keeps every word and every
colour. If you preferred the one you had, the panel offers it straight back by
name — nothing about trying a different design is one-way, and nothing is public
until you press Publish.

The layout lives in \`style.css\`. The top half is shared by every design; the
part below the template's name is what makes this one look like itself.

## Adding a section

The Website tab's **Insert a section** menu drops a ready-made block into the
file you have open — a fleet list, an events list, the Instagram wall. Every
design uses the same class names, so a block from one looks right in another.

## What you can put here

Text files only: \`.html .css .js .json .svg .txt .md .xml .webmanifest\`.

**Pictures are separate and do not count against your page budget.** Upload them
under **Pictures** in the Website tab and they get an \`https://\` address you
can use anywhere on the site — in a block's picture field, behind a section, or
by hand in a page you wrote yourself. Everything is resized and re-encoded on the
way in, so a photograph straight off a phone lands at about a tenth of what it
arrived as. Your logo and banner already have addresses too; the VA Profile tab
shows them.

## Your site's address

It runs on its own address, separate from ours. Its JavaScript can read your own
airline's public crew endpoints and nothing else of ours — there is no key in
this site and nothing in it is secret, so you can paste it anywhere.
`;
}

const bytesOf = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

/**
 * A whole site, laid out.
 *
 * 'theme' is optional — a template's own accent, type and mode are used when it
 * is absent, which is what makes picking a design a single click.
 */
function renderTemplate(templateId, va, { feedSrc, crewBase, theme } = {}) {
    const tpl = TEMPLATES[templateId] || TEMPLATES[DEFAULT_TEMPLATE];
    const id = TEMPLATES[templateId] ? templateId : DEFAULT_TEMPLATE;
    const slug = String((va && va.slug) || '');
    const ctx = {
        name: String((va && va.name) || 'Our Virtual Airline'),
        callsign: String((va && va.callsign) || ''),
        slug,
        crewBase: String(crewBase || 'https://inflight.info'),
        crew: `${String(crewBase || 'https://inflight.info')}/crew/${esc(slug)}`,
        feedSrc: String(feedSrc || 'https://inflight.info/crew-feed.js'),
        // What the header and the footer list. A design that produces a join
        // page gets a link to it; one that does not, does not.
        pages: tpl.pages.map(p => ({ path: p.path, label: p.title || 'Home' })),
    };

    const th = normaliseTheme(theme, id);
    const files = tpl.pages.map(p => ({ path: p.path, content: pageHtml(tpl, p, ctx) }));
    files.push({ path: 'theme.css', content: renderThemeCss(th) });
    files.push({ path: 'style.css', content: `${BASE_CSS}\n/* ---- ${tpl.name} ---------------------------------------------------- */\n${tpl.css}` });
    files.push({ path: 'site.js', content: SITE_JS });
    files.push({ path: 'README.md', content: readme(tpl, ctx) });

    return files.map(f => ({
        path: f.path,
        content: f.content,
        bytes: bytesOf(f.content),
        updatedAt: new Date(),
    }));
}

/** One block's markup, for the editor's "Insert a section" menu. */
function renderBlock(blockId, va, { crewBase } = {}) {
    const block = BLOCKS[blockId];
    if (!block) return null;
    const slug = String((va && va.slug) || '');
    const base = String(crewBase || 'https://inflight.info');
    return block({
        name: String((va && va.name) || 'Our Virtual Airline'),
        callsign: String((va && va.callsign) || ''),
        slug,
        crewBase: base,
        crew: `${base}/crew/${esc(slug)}`,
        pages: [],
    }).trim();
}

/** The picker's catalogue. Content-free — no file is rendered to build it. */
function catalogue() {
    return {
        templates: Object.keys(TEMPLATES).map(id => ({
            id,
            name: TEMPLATES[id].name,
            blurb: TEMPLATES[id].blurb,
            tags: TEMPLATES[id].tags,
            accent: TEMPLATES[id].accent,
            font: TEMPLATES[id].font,
            mode: TEMPLATES[id].mode,
            pattern: TEMPLATES[id].pattern || DEFAULT_PATTERN,
            radius: TEMPLATES[id].radius,
            motion: TEMPLATES[id].motion || DEFAULT_MOTION,
            pages: TEMPLATES[id].pages.map(p => p.path),
            thumb: TEMPLATES[id].thumb,
        })),
        fonts: Object.keys(FONTS).map(id => ({ id, label: FONTS[id].label, note: FONTS[id].note })),
        modes: Object.keys(MODES).map(id => ({ id, label: MODES[id].label, note: MODES[id].note || '' })),
        // In the order they are declared, which is least movement to most —
        // the picker renders them as a row and that row should read as a dial.
        motions: Object.keys(MOTION).map(id => ({ id, label: MOTION[id].label, note: MOTION[id].note })),
        // The motif list carries its own CSS so the picker can DRAW each swatch
        // with the real gradients rather than with a screenshot of them. A
        // swatch that is not the pattern it is offering is worse than no
        // swatch: it is a promise the site then breaks.
        patterns: Object.keys(PATTERNS).map(id => ({
            id, label: PATTERNS[id].label, note: PATTERNS[id].note,
            image: PATTERNS[id].image, size: PATTERNS[id].size,
            position: PATTERNS[id].position || '0 0',
        })),
        blocks: INSERTABLE,
        default: DEFAULT_TEMPLATE,
        defaultPattern: DEFAULT_PATTERN,
        defaultMotion: DEFAULT_MOTION,
    };
}

module.exports = {
    TEMPLATES, FONTS, MODES, PATTERNS, MOTION, BLOCKS, INSERTABLE,
    DEFAULT_TEMPLATE, DEFAULT_PATTERN, DEFAULT_MOTION,
    // The two shared assets a builder site needs as much as a hand-written one:
    // the base stylesheet every design is layered on, and the script that hangs
    // the Instagram wall. Exported so vaSiteBuilder.js emits the same style.css
    // and site.js rather than a second copy that drifts.
    BASE_CSS, SITE_JS,
    renderTemplate, renderBlock, renderThemeCss, renderMotionCss, normaliseTheme, catalogue,
    luminance, relativeLuminance, contrast, onAccentFor, hex,
};
