'use strict';

/*
 * crewFeeds.js
 * Which Discord channel each kind of crew-center notice goes to.
 *
 * A VA sets one main webhook and may point any feed at a channel of its own.
 * Kept out of server.js so the routing rules can be tested without a live app;
 * the URL checks (isDiscordWebhookUrl, maskWebhookUrl) stay where they are and
 * are handed in.
 */

// The feeds a VA can point at a Discord channel. Adding one here is most of the
// work of adding a new notification category.
const FEEDS = ['recruitment', 'pireps', 'routes', 'events', 'retention',
    'announcements', 'roster', 'awards', 'library', 'shop'];

// Feeds that stay OFF until they are given a channel of their own. Everything
// above `announcements` predates the split and has always posted to the main
// webhook, so it still does. These are new, and a VA that set one webhook years
// ago did not ask for every join, award and shop order to start landing in it —
// pasting a URL into the row is the opt-in. (Announcements are absent on
// purpose: they are posted by a person pressing a button, so the main channel
// is a fine place for them when nothing more specific is set.)
const OPT_IN = ['roster', 'awards', 'library', 'shop'];

/**
 * Which URL a feed posts to, from a VA record holding `crewWebhookUrl` and
 * `crewWebhooks`. '' when it posts nowhere.
 *
 * `fallbackFeed` is for a notice that moved feeds: schedule notices used to ride
 * the events feed and quiz results the recruitment feed. They go to their new
 * home when the VA has given it a channel, and otherwise exactly where they
 * always went — so nobody loses a notice by not having set the new row up.
 */
function hookFrom(doc, feed, { fallbackFeed = '', isValid = () => true } = {}) {
    if (!doc) return '';
    const hooks = doc.crewWebhooks || {};
    let u = FEEDS.includes(feed) ? hooks[feed] : '';
    if (!u && fallbackFeed) u = (FEEDS.includes(fallbackFeed) && hooks[fallbackFeed]) || doc.crewWebhookUrl;
    else if (!u && !OPT_IN.includes(feed)) u = doc.crewWebhookUrl;
    return u && isValid(u) ? u : '';
}

/**
 * Per-feed state for the settings screen. `usingDefault` says "this feed is
 * going to your main channel" rather than leaving a blank box that looks like
 * nothing is configured. An `optIn` feed has no default — an empty box there
 * means off, and the row has to say so.
 */
function states(doc, { mask = () => '' } = {}) {
    const hooks = (doc && doc.crewWebhooks) || {};
    const main = !!(doc && doc.crewWebhookUrl);
    return FEEDS.reduce((acc, feed) => {
        const url = hooks[feed] || '';
        const optIn = OPT_IN.includes(feed);
        acc[feed] = { configured: !!url, hint: mask(url), usingDefault: !url && main && !optIn, optIn };
        return acc;
    }, {});
}

module.exports = { FEEDS, OPT_IN, hookFrom, states };
