// Worker onboarding: field validation, step rules, completion scoring and the verification state machine.
// Pure functions (no DB / network) so they are unit-testable; controllers do the I/O.

const TOTAL_STEPS = 5;

const DOCUMENT_TYPES = {
  GOVT_ID_PASSPORT: { group: 'IDENTITY', label: 'Passport' },
  GOVT_ID_DRIVING_LICENCE: { group: 'IDENTITY', label: 'Driving licence' },
  GOVT_ID_VOTER_ID: { group: 'IDENTITY', label: 'Voter ID' },
  GOVT_ID_PAN: { group: 'IDENTITY', label: 'PAN card' },
  GOVT_ID_AADHAAR_MASKED: { group: 'IDENTITY', label: 'Aadhaar (masked copy only)' },
  GOVT_ID_OTHER: { group: 'IDENTITY', label: 'Other government-issued photo ID' },
  PROFESSIONAL_CERTIFICATE: { group: 'CERTIFICATE', label: 'Professional certificate / licence' },
  SKILL_QUALIFICATION: { group: 'QUALIFICATION', label: 'Skill qualification (optional)' }
};
const isIdentityType = (type) => DOCUMENT_TYPES[type] && DOCUMENT_TYPES[type].group === 'IDENTITY';

// Statuses that mean "a reviewer still has to act" / "the worker has to act" / "closed"
const IN_REVIEW = ['PENDING', 'UNDER_REVIEW'];
const WORKER_EDITABLE = [null, 'RESUBMISSION_REQUIRED', 'REJECTED'];
const canWorkerEdit = (status) => WORKER_EDITABLE.includes(status || null);

// Maps the onboarding state onto the pre-existing coarse User/WorkerProfile.verificationStatus
// (which the badge, search and the older admin table read). Email verification is never touched.
const LEGACY_STATUS = {
  PENDING: 'PENDING_REVIEW',
  UNDER_REVIEW: 'PENDING_REVIEW',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  RESUBMISSION_REQUIRED: 'UNVERIFIED'
};
const toLegacyStatus = (status) => LEGACY_STATUS[status] || 'UNVERIFIED';

// ── Sanitising / validating ──────────────────────────────────────────────────

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max) : '');
const intIn = (value, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const moneyIn = (value, max) => {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
};
const list = (value, maxItems, maxLen) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const t = text(item, maxLen);
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
    if (out.length >= maxItems) break;
  }
  return out;
};
const PHONE_RE = /^\+?[0-9][0-9\s-]{6,17}[0-9]$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Returns { value, errors } for each step. `value` only holds sanitised, known keys.
const STEP_VALIDATORS = {
  1: (input = {}) => {
    const value = {
      fullName: text(input.fullName, 100),
      phone: text(input.phone, 20),
      city: text(input.city, 80),
      locality: text(input.locality, 80),
      address: text(input.address, 300)
    };
    const errors = {};
    if (value.fullName.length < 2) errors.fullName = 'Enter your full name.';
    if (!PHONE_RE.test(value.phone)) errors.phone = 'Enter a valid phone number.';
    if (value.city.length < 2) errors.city = 'Enter your city.';
    if (value.locality.length < 2) errors.locality = 'Enter your locality / area.';
    if (value.address.length < 10) errors.address = 'Enter your complete service address (at least 10 characters).';
    return { value, errors };
  },
  2: (input = {}) => {
    const value = {
      categoryId: text(input.categoryId, 64),
      experienceYears: intIn(input.experienceYears, 0, 60),
      skills: list(input.skills, 15, 40),
      description: text(input.description, 1500),
      previousExperience: text(input.previousExperience, 1500),
      languages: list(input.languages, 10, 30)
    };
    const errors = {};
    if (!value.categoryId) errors.categoryId = 'Select your profession.';
    if (value.experienceYears === null) errors.experienceYears = 'Enter your years of experience (0-60).';
    if (value.skills.length < 1) errors.skills = 'Add at least one skill.';
    if (value.description.length < 30) errors.description = 'Describe your services (at least 30 characters).';
    if (value.languages.length < 1) errors.languages = 'Add at least one language.';
    return { value, errors };
  },
  3: (input = {}) => ({ value: { idPolicyAcknowledged: input.idPolicyAcknowledged === true }, errors: {} }),
  4: (input = {}) => {
    const hours = Array.isArray(input.workingHours) ? input.workingHours : [];
    const seenDays = new Set();
    const workingHours = [];
    for (const row of hours) {
      const day = intIn(row && row.dayOfWeek, 0, 6);
      if (day === null || seenDays.has(day)) continue;
      seenDays.add(day);
      workingHours.push({
        dayOfWeek: day,
        startTime: TIME_RE.test(row.startTime) ? row.startTime : '09:00',
        endTime: TIME_RE.test(row.endTime) ? row.endTime : '18:00',
        isActive: row.isActive !== false
      });
    }
    const value = {
      additionalCategoryIds: list(input.additionalCategoryIds, 5, 64),
      hourlyRate: moneyIn(input.hourlyRate, 100000),
      startingCharge: moneyIn(input.startingCharge, 100000),
      serviceRadiusKm: intIn(input.serviceRadiusKm, 1, 100),
      workingHours
    };
    const errors = {};
    if (!((value.hourlyRate || 0) > 0 || (value.startingCharge || 0) > 0)) errors.pricing = 'Enter an hourly rate or a starting charge.';
    if (value.serviceRadiusKm === null) errors.serviceRadiusKm = 'Service radius must be 1-100 km.';
    const active = workingHours.filter((h) => h.isActive);
    if (active.length < 1) errors.workingHours = 'Select at least one working day.';
    if (active.some((h) => h.startTime >= h.endTime)) errors.workingHours = 'Working hours must end after they start.';
    return { value, errors };
  },
  5: (input = {}) => ({ value: { declaration: input.declaration === true }, errors: {} })
};

const validateStep = (step, input) => {
  const fn = STEP_VALIDATORS[step];
  if (!fn) return { value: {}, errors: { step: 'Unknown step.' } };
  return fn(input);
};

const STEP_KEYS = { 1: 'personal', 2: 'professional', 3: 'identity', 4: 'service', 5: 'review' };

// Validates the whole draft + preconditions for submission. Returns a flat list of problems.
const validateForSubmit = ({ draft = {}, hasAvatar, documents = [], categoryIds = [] }) => {
  const problems = [];
  for (const step of [1, 2, 4]) {
    const { errors } = validateStep(step, draft[STEP_KEYS[step]]);
    Object.entries(errors).forEach(([field, message]) => problems.push({ step, field, message }));
  }
  const professional = validateStep(2, draft.professional).value;
  const service = validateStep(4, draft.service).value;
  if (professional.categoryId && !categoryIds.includes(professional.categoryId)) {
    problems.push({ step: 2, field: 'categoryId', message: 'Selected profession is not available.' });
  }
  for (const id of service.additionalCategoryIds) {
    if (!categoryIds.includes(id)) problems.push({ step: 4, field: 'additionalCategoryIds', message: 'A selected service category is not available.' });
  }
  if (!hasAvatar) problems.push({ step: 1, field: 'photo', message: 'Upload a profile photograph.' });
  const current = documents.filter((d) => d.isCurrent);
  if (!current.some((d) => isIdentityType(d.type))) {
    problems.push({ step: 3, field: 'identity', message: 'Upload one government-issued photo ID (several types are accepted).' });
  }
  const flagged = current.filter((d) => d.status === 'REJECTED' || d.status === 'RESUBMISSION_REQUIRED');
  if (flagged.length) {
    problems.push({ step: 3, field: 'documents', message: 'Replace or remove the documents the reviewer flagged before resubmitting.' });
  }
  if (!(draft.review && draft.review.declaration === true)) {
    problems.push({ step: 5, field: 'declaration', message: 'Confirm that your details are accurate and you consent to document review.' });
  }
  return problems;
};

// ── Profile completion (dashboard) ───────────────────────────────────────────

const computeCompletion = ({ user, profile, documents = [], skillsCount = 0, availabilityCount = 0 }) => {
  const currentDocs = documents.filter((d) => d.isCurrent);
  const items = [
    { key: 'photo', label: 'Profile photograph', done: Boolean(user && user.avatarUrl) },
    { key: 'contact', label: 'Phone number', done: Boolean(user && user.phone && !/^\+91 00000 00000$/.test(user.phone)) },
    { key: 'location', label: 'City, locality and service address', done: Boolean(profile && profile.city && profile.locality && profile.serviceAddress) },
    { key: 'profession', label: 'Profession', done: Boolean(profile && profile.primaryCategoryId) },
    { key: 'experience', label: 'Experience and description', done: Boolean(profile && profile.bio && profile.bio.trim().length >= 30) },
    { key: 'skills', label: 'Skills', done: skillsCount > 0 },
    { key: 'languages', label: 'Languages spoken', done: Boolean(profile && profile.languages && profile.languages.length > 0) },
    { key: 'pricing', label: 'Pricing', done: Boolean(profile && (Number(profile.hourlyRate) > 0 || Number(profile.inspectionFee) > 0)) },
    { key: 'hours', label: 'Working hours', done: availabilityCount > 0 },
    { key: 'identity', label: 'Identity document uploaded', done: currentDocs.some((d) => isIdentityType(d.type)) }
  ];
  const done = items.filter((i) => i.done).length;
  return { percent: Math.round((done / items.length) * 100), items };
};

// ── Admin decision rules ─────────────────────────────────────────────────────

const canApprove = (status, documents = []) => {
  if (!IN_REVIEW.includes(status)) return { ok: false, reason: 'Only submissions that are pending or under review can be approved.' };
  const current = documents.filter((d) => d.isCurrent);
  if (!current.some((d) => isIdentityType(d.type) && d.status === 'VERIFIED')) {
    return { ok: false, reason: 'Verify at least one identity document before approving.' };
  }
  const open = current.filter((d) => ['PENDING', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED'].includes(d.status));
  if (open.length) return { ok: false, reason: 'Review every document first (verify it, or reject it if it is optional and unacceptable).' };
  return { ok: true };
};

module.exports = {
  TOTAL_STEPS, DOCUMENT_TYPES, STEP_KEYS, IN_REVIEW,
  isIdentityType, canWorkerEdit, toLegacyStatus,
  validateStep, validateForSubmit, computeCompletion, canApprove
};
