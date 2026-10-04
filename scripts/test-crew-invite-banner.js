// test-crew-invite-banner.js
// The welcome message staff paste on the IFC: the airline's banner on top, the
// small "Welcome aboard" strip underneath, and the same words in between as
// every other copy of the invitation.
//
// What is defended:
//   * the IFC copy opens with the banner and closes with the strip, each on a
//     line of its own (Discourse only draws a picture that is)
//   * the words between them are exactly the plain message — the pictures are
//     a frame, never a second version of what the pilot is told
//   * the applicant's own status page stays plain text
//   * a URL that is not plain https never reaches the message
//   * both pictures draw, at the size the message asks for, and a logo that
//     will not download still leaves a picture (the airline's initials)
//
// Run:  node scripts/test-crew-invite-banner.js
'use strict';

const sharp = require('sharp');
const crewInvite = require('../crewInvite');
const crewPasswordReset = require('../crewPasswordReset');
const banner = require('../crewInviteBanner');

let pass = 0;
const fails = [];
const check = (what, ok, saw) => {
    if (ok) pass++;
    else fails.push(what + (saw === undefined ? '' : `  (saw ${JSON.stringify(saw).slice(0, 300)})`));
};

const ART = { bannerUrl: 'https://cdn.example/ba-banner.webp', footerUrl: 'https://api.example/api/crew/ba/invite-banner.png?kind=footer&v=1' };
const CTX = { vaName: 'British Airways Virtual', ifcName: 'rae', callsign: 'BAW 101', signInUrl: 'https://inflight.info/crew/ba', ...ART };

(async () => {
    {
        const ifc = crewInvite.buildInviteMessage({ ...CTX, username: 'rae', password: 'Pw23456789', format: 'ifc' });
        const plain = crewInvite.buildInviteMessage({ ...CTX, username: 'rae', password: 'Pw23456789' });
        const lines = ifc.split('\n');
        check('the IFC copy opens with the airline’s banner', lines[0] === `![British Airways Virtual](${ART.bannerUrl})`, lines[0]);
        check('…on a line of its own', lines[1] === '', lines[1]);
        check('…and closes with the welcome strip, sized small', lines[lines.length - 1] === `![Welcome aboard — British Airways Virtual|600x100](${ART.footerUrl})`, lines[lines.length - 1]);
        check('…with a blank line before it', lines[lines.length - 2] === '');
        check('the words in between are exactly the plain message', ifc.includes(plain));
        check('the plain message carries no pictures', !/!\[/.test(plain));
    }
    {
        const app = { invitePassword: 'Pw23456789', inviteUsername: 'rae', inviteIssuedAt: new Date() };
        const staff = crewInvite.staffInvite(app, CTX);
        check('staff get the IFC copy as the message', staff.message.startsWith('![British Airways Virtual]'), staff.message);
        check('…and the same words plain, for Discord', staff.plainMessage && !/!\[/.test(staff.plainMessage) && staff.message.includes(staff.plainMessage));
        const mine = crewInvite.applicantCredentials(app, CTX);
        check('the applicant’s own status page stays plain text', mine && !/!\[/.test(mine.message), mine && mine.message);
        const dead = crewInvite.staffInvite({ ...app, inviteClaimedAt: new Date() }, CTX);
        check('a used invitation has no message of either kind', dead.message === '' && dead.plainMessage === '');
    }
    {
        const evil = crewInvite.forIfc('hello', { vaName: 'X', bannerUrl: 'javascript:alert(1)', footerUrl: 'http://plain.example/x.png' });
        check('a URL that is not plain https never reaches the message', evil === 'hello', evil);
        const spaced = crewInvite.forIfc('hello', { vaName: 'X', bannerUrl: 'https://a.example/x y.png)' });
        check('…nor one that could break out of the markdown', spaced === 'hello', spaced);
        const odd = crewInvite.forIfc('hi', { vaName: 'A|B [C]', footerUrl: ART.footerUrl });
        check('the alt text cannot break Discourse’s sizing syntax', /^!\[Welcome aboard — A B C\|600x100\]/m.test(odd.split('\n').pop()), odd);
    }
    {
        const msg = crewPasswordReset.buildSetupMessage({ vaName: 'BA', name: 'Rae', username: 'rae', link: 'https://inflight.info/crew/ba?reset=x', format: 'ifc', ...ART });
        check('a setup-link invitation is framed the same way', msg.startsWith('![BA](') && /\|600x100\]/.test(msg), msg);
        const plain = crewPasswordReset.buildSetupMessage({ vaName: 'BA', name: 'Rae', username: 'rae', link: 'https://inflight.info/crew/ba?reset=x' });
        check('…and its plain form is unchanged', !/!\[/.test(plain) && msg.includes(plain));
    }
    {
        const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: '#c8102e' } }).png().toBuffer();
        const foot = await banner.render({ name: 'British Airways Virtual', logoUrl: 'https://x/logo.png', accent: '#c8102e', url: 'https://inflight.info/crew/ba', fetch: async () => logo });
        const m = await sharp(foot).metadata();
        check('the strip is drawn 1200×200 (shown at 600×100)', m.format === 'png' && m.width === 1200 && m.height === 200, m);
        const noLogo = await banner.render({ name: 'Qatar Virtual', logoUrl: 'https://x/missing.png', fetch: async () => null });
        check('a logo that will not download still leaves a picture', (await sharp(noLogo).metadata()).width === 1200);
        const head = await banner.render({ kind: 'header', name: 'Qatar Virtual' });
        const hm = await sharp(head).metadata();
        check('the drawn header is 1200×360', hm.width === 1200 && hm.height === 360, hm);
        const local = await banner.render({ name: 'X', logoUrl: 'file:///etc/passwd' });
        check('a logo that is not https is never read — initials instead', (await sharp(local).metadata()).width === 1200);
        check('a colour that is not a colour falls back', banner.accentOf('red;evil') === '#2563eb' && banner.accentOf('#abc') === '#aabbcc');
        check('a name with markup is drawn as text', (await sharp(await banner.render({ name: '<script>&"' })).metadata()).width === 1200);
    }

    console.log(`${pass} passed, ${fails.length} failed`);
    if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
})().catch((err) => { console.error(err); process.exit(1); });
