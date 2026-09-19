'use strict';

/*
 * crewQuizzes.js
 * Multiple-choice quizzes, the banners they are read under, and the door a VA
 * can put in front of its own crew centre.
 *
 * WHAT THIS IS FOR
 * ----------------
 * An airline that wants to know somebody has read the SOP before it lets them
 * near the fleet has exactly one way of finding out today: ask them in Discord
 * and believe the answer. So the induction happens, or it does not, and nobody
 * can tell which afterwards — least of all the pilot, who has no way to prove
 * they did the reading.
 *
 * A QUIZ is a short list of multiple-choice questions with a pass mark. It is
 * config — like the rank ladder, the join form and the staff openings — so it
 * lives on the VA's own record beside them.
 *
 * An ATTEMPT is one pilot sitting one quiz. That is a person's answers and a
 * result that follows them around, so it lives in the VA's own database with
 * the rest of their people: crew_quiz_attempts, schema v22.
 *
 * THE RULE THIS MODULE KEEPS
 * --------------------------
 * THE ANSWERS NEVER LEAVE THE SERVER. `publicQuiz` strips `correct` from every
 * question, and `grade` is the only thing that reads it. A quiz whose answer key
 * is sitting in the page the taker is looking at is not a quiz, and a client
 * that marked its own paper would be scoring the exam it is sitting.
 *
 * THE DOOR FAILS OPEN, NOT SHUT
 * -----------------------------
 * `gateState` is asked "may this pilot in?" and answers "yes" whenever it cannot
 * tell — no gate configured, the quiz deleted from under it, a store that would
 * not answer. A crew centre locked because a database was slow is an outage the
 * airline did not ask for and cannot explain, where a pilot who slips through a
 * gate for one afternoon is a pilot the next sign-in stops. Staff are never
 * gated at all: the person who would unlock it must not be behind it.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No timer, no proctoring, no shuffling of the options. All three sound like
 * exam integrity and none of them survive contact with a volunteer airline: the
 * quiz is a reading check that staff can re-issue at will, not an invigilated
 * paper, and every one of those features costs a screen full of settings to
 * explain what happens when it fires.
 */

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const int = (v, lo, hi, dflt = 0) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
};

const MAX_QUIZZES = 12;
const MAX_QUESTIONS = 30;
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;

/** Statuses an attempt can hold, in the order they happen. */
const ATTEMPT_STATUSES = ['issued', 'started', 'passed', 'failed', 'revoked'];

function slugifyQuizId(s) {
    const base = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || ('quiz-' + Math.random().toString(36).slice(2, 8));
}

/**
 * A picture a VA has pointed us at.
 *
 * http(s) only, and length-capped. Anything else — a data: URI that would put a
 * megabyte of base64 in the VA's record, a javascript: URL that would run in
 * every pilot's browser — is dropped to empty rather than rejected, because a
 * banner is decoration and a save must not fail over one.
 */
function cleanImageUrl(v) {
    const s = clean(v, 500);
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) return '';
    return s;
}

/**
 * One question, cleaned.
 *
 * Returns null — and the caller drops it — when the question could not be
 * marked: fewer than two options, or a `correct` index pointing at an option
 * that is not there. A question nobody can get right would fail every taker on
 * the airline's mistake, which is worse than the question not existing.
 */
function sanitizeQuestion(q, i) {
    const text = clean(q && q.text, 300);
    const options = (Array.isArray(q && q.options) ? q.options : [])
        .map((o) => clean(o, 200)).filter(Boolean).slice(0, MAX_OPTIONS);
    if (!text || options.length < MIN_OPTIONS) return null;
    const correct = int(q && q.correct, 0, options.length - 1, -1);
    if (correct < 0) return null;
    return {
        id: clean(q && q.id, 40) || `q${i + 1}`,
        text,
        options,
        correct,
    };
}

/**
 * The airline's quizzes, cleaned and bounded.
 *
 * Ids are stable across saves where the caller sends them back, which it does:
 * an attempt row holds `quiz_id` and the entry gate names one, so regenerating
 * ids on every save would orphan every result and quietly unlock the door.
 */
function sanitizeQuizzes(arr) {
    if (!Array.isArray(arr)) return null;
    const seen = new Set();
    return arr.slice(0, MAX_QUIZZES).map((qz) => {
        const title = clean(qz && qz.title, 120) || 'Quiz';
        let id = slugifyQuizId((qz && qz.id) || title);
        for (let n = 2; seen.has(id); n += 1) id = `${slugifyQuizId(title)}-${n}`;
        seen.add(id);
        const questions = (Array.isArray(qz && qz.questions) ? qz.questions : [])
            .slice(0, MAX_QUESTIONS).map(sanitizeQuestion).filter(Boolean);
        return {
            id,
            title,
            blurb: clean(qz && qz.blurb, 600),
            banner: cleanImageUrl(qz && qz.banner),
            // A pass mark of 0 would pass a blank paper, and one of 100 fails a
            // pilot for a typo on question nineteen. Both are the airline's to
            // choose; neither is the default.
            passMark: int(qz && qz.passMark, 1, 100, 80),
            // 0 means "as many as they like". The default is three, which is
            // enough to survive a misread question and few enough that the
            // fourth go is a conversation with staff rather than a grind.
            maxAttempts: int(qz && qz.maxAttempts, 0, 20, 3),
            // Self-serve: any pilot can sit it whenever they like. Off by
            // default, because the flow this was built for is staff handing
            // somebody a link.
            open: !!(qz && qz.open),
            active: !(qz && qz.active === false),
            questions,
        };
    });
}

/** Can this quiz be sat at all? A quiz with no questions is a draft. */
const isReady = (q) => !!(q && q.active && Array.isArray(q.questions) && q.questions.length > 0);

/**
 * A quiz as a TAKER sees it — without the answer key.
 *
 * `withAnswers` is for the builder and nothing else. Every route that hands a
 * quiz to a pilot leaves it off; see the head of this file.
 */
function publicQuiz(q, { withAnswers = false } = {}) {
    return {
        id: q.id,
        title: q.title,
        blurb: q.blurb,
        banner: q.banner,
        passMark: q.passMark,
        maxAttempts: q.maxAttempts,
        open: q.open,
        active: q.active,
        ready: isReady(q),
        questionCount: (q.questions || []).length,
        questions: (q.questions || []).map((qq) => (withAnswers
            ? { id: qq.id, text: qq.text, options: qq.options.slice(), correct: qq.correct }
            : { id: qq.id, text: qq.text, options: qq.options.slice() })),
    };
}

/**
 * Mark a paper.
 *
 * `answers` is positional — the index the taker picked for each question, in
 * the order the questions were sent. Positional rather than keyed by question
 * id for the same reason the staff application form is: what was asked is the
 * airline's, and a client that posted its own copy of the questions could put
 * words in the airline's mouth on a row staff will read as a record.
 *
 * An unanswered question is wrong, not skipped. A pass mark is a share of the
 * paper, and letting somebody leave out what they did not know would make 80%
 * mean "80% of what they attempted".
 */
function grade(quiz, answers) {
    const qs = (quiz && quiz.questions) || [];
    const given = Array.isArray(answers) ? answers : [];
    const marks = qs.map((q, i) => {
        const chosen = int(given[i], -1, MAX_OPTIONS - 1, -1);
        return {
            id: q.id,
            question: q.text,
            chosen,
            chosenText: chosen >= 0 ? (q.options[chosen] || '') : '',
            correct: q.correct,
            correctText: q.options[q.correct] || '',
            right: chosen === q.correct,
        };
    });
    const total = marks.length;
    const score = marks.filter((m) => m.right).length;
    // Rounded down, so a pass mark of 80 is not cleared by 79.5%.
    const percent = total ? Math.floor((score / total) * 100) : 0;
    return {
        total,
        score,
        percent,
        passed: total > 0 && percent >= (Number(quiz.passMark) || 0),
        marks,
    };
}

/**
 * The door. `quizId` names the quiz somebody must pass to get in.
 *
 * Pointed at a quiz that has been deleted — or one with no questions in it —
 * the gate turns itself off rather than locking the airline out of its own crew
 * centre over a quiz nobody can sit. Same rule as an opening whose role has
 * gone: config that cannot be honoured is not kept.
 */
function sanitizeGate(gate, quizzes) {
    const list = Array.isArray(quizzes) ? quizzes : [];
    const quizId = clean(gate && gate.quizId, 40);
    const quiz = list.find((q) => q.id === quizId);
    const usable = !!(quiz && isReady(quiz));
    return {
        enabled: !!(gate && gate.enabled) && usable,
        quizId: usable ? quizId : '',
        message: clean(gate && gate.message, 400),
        // Whether a pilot may start it themselves. Off by default: the flow
        // this was built for is staff sending somebody a link when they are
        // ready for them, and an entry quiz anybody can start the moment they
        // are accepted is a different feature.
        allowSelfStart: !!(gate && gate.allowSelfStart),
    };
}

/** The banners a VA puts over its own recruitment screens. */
function sanitizeBanners(b) {
    return {
        apply: cleanImageUrl(b && b.apply),
        quiz: cleanImageUrl(b && b.quiz),
    };
}

/**
 * Reminding staff that somebody is waiting.
 *
 * `everyHours` is a floor between digests rather than a schedule: the sweep
 * runs hourly and posts only when something has been waiting AND this long has
 * passed since the last post. A reminder that arrived on the hour whether or
 * not there was anything to say is a reminder people mute.
 */
function sanitizeReminders(r) {
    return {
        enabled: !!(r && r.enabled),
        everyHours: int(r && r.everyHours, 1, 168, 24),
        // What is worth a nudge. All three on by default, because a VA that has
        // switched reminders on has said what it wants; the ticks are for the
        // airline that runs its applications in Discord and only wants the
        // quizzes chased.
        applications: !(r && r.applications === false),
        staffApplications: !(r && r.staffApplications === false),
        quizzes: !(r && r.quizzes === false),
        // How long something has to have been sitting before it counts as
        // waiting. A reminder about an application that landed four minutes ago
        // is noise; staff have not had a chance yet.
        afterHours: int(r && r.afterHours, 1, 336, 24),
    };
}

/** One attempt as STAFF see it. */
function attemptView(a) {
    return {
        id: a._id,
        quizId: a.quizId,
        quizTitle: a.quizTitle,
        memberId: a.memberId,
        pilotName: a.pilotName,
        callsign: a.callsign,
        status: a.status,
        gate: !!a.gate,
        score: a.score,
        total: a.total,
        passMark: a.passMark,
        percent: a.total ? Math.floor((Number(a.score) || 0) / a.total * 100) : 0,
        attemptsUsed: a.attemptsUsed,
        maxAttempts: a.maxAttempts,
        issuedBy: a.issuedBy,
        note: a.note,
        createdAt: a.createdAt,
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
    };
}

/**
 * And as the PILOT sees their own.
 *
 * The token comes with it, because the pilot's own screen is where the link
 * they were sent is reopened. Never the marks: which questions they got wrong
 * is the answer key read backwards, and a pilot with two goes left could walk
 * it out of a failed paper.
 */
function myAttemptView(a) {
    const v = attemptView(a);
    delete v.issuedBy;
    v.token = a.token || '';
    return v;
}

/** Why this pilot cannot sit this attempt now, or '' if they can. */
function takeFailure(quiz, attempt) {
    if (!attempt) return 'That quiz link is not valid. Ask your staff for a new one.';
    if (attempt.status === 'revoked') return 'That quiz link has been withdrawn. Ask your staff about it.';
    if (attempt.status === 'passed') return 'You have already passed this one.';
    if (!quiz) return 'That quiz no longer exists. Ask your staff about it.';
    if (!isReady(quiz)) return 'That quiz has no questions in it yet. Ask your staff about it.';
    const max = Number(attempt.maxAttempts) || 0;
    if (max > 0 && (Number(attempt.attemptsUsed) || 0) >= max) {
        return `You have used all ${max} attempt${max === 1 ? '' : 's'} at this one. Your staff can give you another go.`;
    }
    return '';
}

/**
 * Where a pilot stands against the door.
 *
 * Answers in the airline's terms — locked or not, and what the pilot can do
 * about it — from three things this module is given rather than fetching: the
 * gate, the quiz it names, and this pilot's own attempts at it. Everything it
 * cannot establish it reads as open; see the head of the file.
 */
function gateState({ gate, quizzes, attempts, isStaff = false } = {}) {
    const out = {
        enabled: !!(gate && gate.enabled),
        locked: false,
        quizId: (gate && gate.quizId) || '',
        quizTitle: '',
        message: (gate && gate.message) || '',
        allowSelfStart: !!(gate && gate.allowSelfStart),
        token: '',
        status: '',
        canStart: false,
        attemptsLeft: 0,
    };
    if (!out.enabled) return out;
    const quiz = (Array.isArray(quizzes) ? quizzes : []).find((q) => q.id === out.quizId);
    if (!isReady(quiz)) return out;                 // a door with no key in it
    out.quizTitle = quiz.title;
    // Staff are never held at the door — see the head of this file.
    if (isStaff) return out;

    const mine = (Array.isArray(attempts) ? attempts : [])
        .filter((a) => a.quizId === out.quizId)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    if (mine.some((a) => a.status === 'passed')) return out;   // through it, for good

    const live = mine.find((a) => a.status === 'issued' || a.status === 'started' || a.status === 'failed');
    out.locked = true;
    out.status = live ? live.status : 'none';
    if (live) {
        out.token = live.token || '';
        const max = Number(live.maxAttempts) || 0;
        out.attemptsLeft = max > 0 ? Math.max(0, max - (Number(live.attemptsUsed) || 0)) : -1;
        out.canStart = !takeFailure(quiz, live);
    } else if (out.allowSelfStart) {
        // No link, but the airline lets pilots start it themselves. The screen
        // offers the quiz and the server mints the attempt when they do.
        out.canStart = true;
        out.attemptsLeft = -1;
    }
    return out;
}

/** A link is a secret: 32 hex characters from the platform's own randomness. */
function attemptToken(rand) {
    const bytes = (rand || require('crypto').randomBytes)(16);
    return Buffer.from(bytes).toString('hex');
}

module.exports = {
    MAX_QUIZZES, MAX_QUESTIONS, MAX_OPTIONS, MIN_OPTIONS, ATTEMPT_STATUSES,
    slugifyQuizId, cleanImageUrl, sanitizeQuestion, sanitizeQuizzes,
    isReady, publicQuiz, grade,
    sanitizeGate, sanitizeBanners, sanitizeReminders,
    attemptView, myAttemptView, takeFailure, gateState, attemptToken,
};
