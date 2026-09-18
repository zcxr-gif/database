'use strict';

/*
 * crewStaffApps.js
 * Openings, and pilots applying for them.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Becoming staff at a VA had exactly one route: the owner noticed somebody,
 * opened the team editor and promoted them. Everything that happens BEFORE that
 * moment — the airline deciding it needs a second PIREP reviewer, a pilot
 * saying they would like to help, the owner weighing up three volunteers —
 * happened in Discord, off the record, and the crew centre knew nothing about
 * it. Which made the owner the bottleneck and the only person who could see the
 * queue, because there was no queue.
 *
 * So there are two halves here:
 *
 *   An OPENING is a job the airline has advertised. It lives on the VA's own
 *   record next to the staff roles, because it IS a staff role with a job
 *   advert wrapped round it — a title, a sentence about the work, up to a
 *   handful of questions, and an hours bar. Config, like the rank ladder and
 *   the join form, held where those are held.
 *
 *   An APPLICATION is one pilot asking for one opening. That is the pilot's own
 *   words about themselves, so it lives in the VA's own database with the rest
 *   of their people — crew_staff_applications, schema v20.
 *
 * THE RULE THIS MODULE KEEPS
 * --------------------------
 * An opening cannot advertise a job the airline cannot give. `roleId` must name
 * a staff role that exists, and sanitizeOpenings DROPS an opening whose role
 * has been deleted rather than keeping a post that would promote somebody into
 * nothing. The accept path re-resolves the role again at the moment of
 * accepting, because a role can go away between the advert and the decision.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No separate "staff recruiter" capability. Accepting an application mints a
 * staff login, which is the escalation the whole permission system is careful
 * about, so hiring is gated on `team.manage` — the capability that already
 * means "build the team". A seventeenth capability whose only job was to be
 * ticked alongside an existing one would make the permissions screen longer and
 * the answer to "who can hire?" less obvious, which is the opposite of the
 * point.
 */

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const MAX_OPENINGS = 20;
const MAX_QUESTIONS = 6;

function slugifyOpeningId(s) {
    const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || ('opening-' + Math.random().toString(36).slice(2, 8));
}

/**
 * The airline's openings, cleaned and bounded.
 *
 * `roles` is the VA's staffRoles array. An opening pointing at a role that is
 * not in it is dropped — see the note at the head of this file. That is a
 * deletion the owner did not explicitly ask for, so it is the one thing here
 * worth being loud about in the UI: the openings editor greys out a role that
 * has gone and says so, rather than letting a save silently shorten the list.
 *
 * Ids are stable across saves where the caller sends them back, which it does:
 * an application row holds `opening_id`, and regenerating ids on every save
 * would orphan every application in the queue.
 */
function sanitizeOpenings(arr, roles) {
    if (!Array.isArray(arr)) return null;
    const known = new Set((Array.isArray(roles) ? roles : []).map(r => r && r.id).filter(Boolean));
    const seen = new Set();
    return arr.slice(0, MAX_OPENINGS).map((o) => {
        const roleId = clean(o && o.roleId, 40);
        const title = clean(o && o.title, 120);
        let id = slugifyOpeningId((o && o.id) || title || roleId);
        // Two openings for the same role are legitimate — "Events coordinator
        // (Europe)" and "(Americas)" — so a collision gets a suffix rather than
        // dropping the second one on the floor.
        for (let n = 2; seen.has(id); n += 1) id = `${slugifyOpeningId(title || roleId)}-${n}`;
        seen.add(id);
        return {
            id,
            roleId,
            title: title || 'Staff',
            blurb: clean(o && o.blurb, 400),
            questions: (Array.isArray(o && o.questions) ? o.questions : [])
                .map(q => clean(q, 200)).filter(Boolean).slice(0, MAX_QUESTIONS),
            minHours: Math.max(0, Math.min(100000, Math.round(Number(o && o.minHours) || 0))),
            open: !(o && o.open === false),
        };
    }).filter(o => o.roleId && known.has(o.roleId));
}

/**
 * An opening as a PILOT sees it.
 *
 * `can` is what the job actually lets somebody do, in the airline's own words —
 * the labels off the capability catalogue, not the ids. A pilot deciding
 * whether to put their name forward is entitled to know what they would be
 * taking on, and "settings.recruitment, roster.manage" tells them nothing. The
 * caller passes the labels because the catalogue lives in crewAuth and this
 * module does not require it — see the head of the file.
 */
function publicOpening(o, { role = null, labels = [] } = {}) {
    return {
        id: o.id,
        title: o.title,
        blurb: o.blurb,
        questions: o.questions.slice(),
        minHours: o.minHours,
        open: o.open,
        roleName: (role && role.name) || '',
        roleColor: (role && role.color) || '',
        can: labels.slice(),
    };
}

/** Why this pilot cannot apply for this opening, or '' if they can. */
function applyFailure(opening, { hours = 0, isStaff = false, alreadyApplied = false } = {}) {
    if (!opening) return 'That position is no longer being advertised.';
    if (!opening.open) return `${opening.title} isn’t open for applications right now.`;
    // Staff applying for a staff job is not a mistake worth a friendly message —
    // it is a sign the screen showed them something it should not have. Answered
    // plainly rather than cleverly.
    if (isStaff) return 'You’re already on the staff team. Ask an owner to change what you look after.';
    if (alreadyApplied) return 'You’ve already applied for this one. Staff will come back to you.';
    if (opening.minHours > 0 && hours < opening.minHours) {
        return `${opening.title} asks for ${opening.minHours} hours, and you have ${Math.floor(hours)}.`;
    }
    return '';
}

/**
 * The applicant's answers, paired with the questions they were asked.
 *
 * Paired HERE rather than trusted from the client, because the questions are
 * the airline's and the answers are the applicant's: a form posting its own
 * question text could put words in the airline's mouth on a row staff will read
 * as a record of what was asked.
 */
function pairAnswers(questions, answers) {
    const given = Array.isArray(answers) ? answers : [];
    return (Array.isArray(questions) ? questions : []).map((q, i) => ({
        q: clean(q, 200),
        a: clean(given[i], 2000),
    }));
}

/** One row as the reviewer's queue draws it. */
function staffApplicationView(a) {
    return {
        id: a._id,
        openingId: a.openingId,
        roleId: a.roleId,
        position: a.position,
        memberId: a.memberId,
        pilotName: a.pilotName,
        callsign: a.callsign,
        answers: Array.isArray(a.answers) ? a.answers : [],
        status: a.status,
        staffMessage: a.staffMessage,
        decidedBy: a.decidedBy,
        decidedAt: a.decidedAt,
        createdAt: a.createdAt,
    };
}

/** And as the applicant's own screen draws it — without who decided it. */
function myApplicationView(a) {
    const v = staffApplicationView(a);
    // Deliberately dropped. "Declined by @dave" turns a decision the airline
    // made into a thing one named colleague did to them, and these people fly
    // together afterwards.
    delete v.decidedBy;
    return v;
}

module.exports = {
    MAX_OPENINGS, MAX_QUESTIONS,
    sanitizeOpenings, publicOpening, applyFailure, pairAnswers,
    staffApplicationView, myApplicationView, slugifyOpeningId,
};
