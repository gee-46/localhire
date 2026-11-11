const prisma = require('../config/prisma');
const path = require('path');
const supabaseConfig = require('../config/supabase');
const { sniffMime } = require('../services/documentStorage');
const { VERIFIED_PROFILE } = require('../services/workerEligibility');
const { realAvatarUrl } = require('../services/avatar');
const { parseDiscoveryQuery, discover, approximateDistanceKm } = require('../services/workerDiscovery');
const FRESH_MS = 15 * 60 * 1000;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const slugify = (value) => String(value || 'other')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'other';

const ensureCategory = async (categoryName) => {
  const name = String(categoryName || 'Other').trim() || 'Other';
  let category = await prisma.serviceCategory.findFirst({
    where: {
      OR: [
        { name },
        { slug: slugify(name) }
      ]
    }
  });

  if (!category) {
    category = await prisma.serviceCategory.create({
      data: {
        name,
        slug: slugify(name),
        description: `Auto-created category for ${name}`
      }
    });
  }

  return category;
};

// Public worker shape. By default it carries NOTHING private: no email, phone or street address, and
// only a real photograph (never a generated placeholder). `self: true` is for the worker's own responses.
const formatWorker = (user, { self = false } = {}) => {
  const profile = user.workerProfile;
  const categoryName = profile?.primaryCategory?.name || 'General';
  const skills = (profile?.skills || []).map((skill) => skill.skillName).filter(Boolean);

  const hourly = toNumber(profile?.hourlyRate);
  const visit = toNumber(profile?.inspectionFee);
  const startingPrice = hourly > 0 ? hourly : (visit > 0 ? visit : null);
  const priceUnit = hourly > 0 ? 'hour' : (visit > 0 ? 'visit' : null);
  const serviceArea = [profile?.locality, profile?.city].filter(Boolean).join(', ') || null;

  const sharing = profile?.locationSharing;
  const availableNow = Boolean(sharing && sharing.isAvailable && sharing.sharingEnabled && sharing.lastLocationUpdate
    && (Date.now() - new Date(sharing.lastLocationUpdate).getTime()) <= FRESH_MS);

  const worker = {
    id: user.id,
    _id: user.id,
    name: user.name,
    role: 'Worker',
    avatarUrl: realAvatarUrl(user.avatarUrl),
    category: categoryName,
    categorySlug: profile?.primaryCategory?.slug || null,
    subCategory: '',
    additionalCategories: (profile?.additionalCategories || []).map((c) => c.category?.name).filter(Boolean),
    hourlyRate: hourly,
    startingCharge: visit,
    startingPrice,
    priceUnit,
    // Only report a rating when real reviews back it; a worker with none has rating = null.
    rating: Number(profile?.reviewsCount || 0) > 0 ? toNumber(profile?.rating) : null,
    reviewsCount: Number(profile?.reviewsCount || 0),
    completedJobsCount: Number(profile?.completedJobsCount || 0),
    bio: profile?.bio || '',
    skills,
    languages: profile?.languages || [],
    experience: `${Number(profile?.experienceYears || 0)} years`,
    experienceYears: Number(profile?.experienceYears || 0),
    businessName: profile?.businessName || '',
    serviceRadiusKm: Number(profile?.serviceRadiusKm || 20),
    serviceArea,
    isVerified: profile?.verificationStatus === 'VERIFIED',
    verificationStatus: profile?.verificationStatus,
    availableNow,
    availability: availableNow ? 'Available now' : 'Not available right now',
    // Never the worker's street address: only the public service area.
    location: {
      address: serviceArea || 'Nearby',
      radiusKm: profile?.serviceRadiusKm || 20
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };

  if (profile?.availabilities) {
    worker.workingHours = profile.availabilities
      .filter((a) => a.isActive)
      .sort((x, y) => x.dayOfWeek - y.dayOfWeek)
      .map((a) => ({ dayOfWeek: a.dayOfWeek, startTime: a.startTime, endTime: a.endTime }));
  }
  if (profile?.portfolio) {
    worker.portfolio = profile.portfolio
      .sort((x, y) => x.sortOrder - y.sortOrder || new Date(y.createdAt) - new Date(x.createdAt))
      .map((item) => ({ id: item.id, url: item.imageUrl, caption: item.caption || '' }));
  }
  if (self) {
    worker.email = user.email;
    worker.phone = user.phone;
  }
  return worker;
};

const WORKER_INCLUDE = {
  workerProfile: {
    include: {
      primaryCategory: true,
      skills: true,
      availabilities: true,
      additionalCategories: { include: { category: { select: { name: true } } } },
      locationSharing: { select: { isAvailable: true, sharingEnabled: true, lastLocationUpdate: true } }
    }
  }
};

// @desc    Discover workers: verified + available only, with real filters and sorting
// @route   GET /api/users/workers
// @access  Public
//   q, category (name or slug), lat+lng, radiusKm, maxPrice, minRating, minExperience,
//   availability=any|today|now (+day, time), reviewedOnly, sort=nearest|rating|price|experience, limit, page
exports.getWorkers = async (req, res) => {
  try {
    const parsed = parseDiscoveryQuery(req.query);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const p = parsed.params;

    const { total, rows } = await discover(p);
    if (!rows.length) return res.json({ success: true, count: 0, total, page: p.page, workers: [] });

    const byProfileId = new Map(rows.map((row) => [row.workerProfileId, row]));
    const users = await prisma.user.findMany({
      where: { role: 'WORKER', isActive: true, workerProfile: { id: { in: [...byProfileId.keys()] }, ...VERIFIED_PROFILE } },
      include: WORKER_INCLUDE
    });
    const order = new Map(rows.map((row, index) => [row.workerProfileId, index]));

    const workers = users
      .filter((user) => user.workerProfile)
      .sort((a, b) => order.get(a.workerProfile.id) - order.get(b.workerProfile.id))
      .map((user) => {
        const worker = formatWorker(user);
        const row = byProfileId.get(user.workerProfile.id);
        worker.availableNow = true;
        worker.availability = 'Available now';
        // Public endpoint: only the worker's service area (locality, city) and a coarse distance. No coordinates of any
        // kind, not even rounded ones, are returned, so there is nothing to plot on a public map.
        if (p.lat !== null && row.distanceKm !== null && row.distanceKm !== undefined) {
          worker.distanceKm = approximateDistanceKm(row.distanceKm);
        }
        return worker;
      });

    return res.json({ success: true, count: workers.length, total, page: p.page, workers });
  } catch (error) {
    console.error('[User Controller] getWorkers error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving workers' });
  }
};

// @desc    Get worker by ID
// @route   GET /api/users/workers/:id
// @access  Public
exports.getWorkerById = async (req, res) => {
  try {
    const rawId = req.params.id;
    let worker = null;

    try {
      worker = await prisma.user.findUnique({
        where: { id: rawId },
        include: { ...WORKER_INCLUDE, workerProfile: { include: { ...WORKER_INCLUDE.workerProfile.include, portfolio: true } } }
      });
    } catch (e) {
      // Invalid UUID format or lookup exception
      worker = null;
    }

    if (!worker || worker.role !== 'WORKER') {
      return res.status(404).json({ success: false, message: 'Worker profile not found' });
    }

    // Only verified, active workers have a public profile. The worker themself, admins, and customers
    // who already have a booking with this worker (their history stays reachable) are the exceptions.
    const isPublic = worker.isActive !== false && worker.workerProfile && worker.workerProfile.verificationStatus === 'VERIFIED';
    if (!isPublic) {
      const viewer = req.user || null;
      let allowed = Boolean(viewer && (viewer.id === worker.id || viewer.role === 'Admin'));
      if (!allowed && viewer && viewer.role === 'Customer') {
        allowed = Boolean(await prisma.booking.findFirst({ where: { customerId: viewer.id, workerId: worker.id }, select: { id: true } }));
      }
      if (!allowed) {
        return res.status(404).json({ success: false, message: 'Worker profile not found' });
      }
    }

    res.json({ success: true, worker: formatWorker(worker) });
  } catch (error) {
    console.error('[User Controller] getWorkerById error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving worker profile', error: error.message });
  }
};

exports.getMyLocationSharing = async (req, res) => {
  try {
    const profile = await prisma.workerProfile.findUnique({
      where: { userId: req.user.id },
      select: {
        id: true,
        locationSharing: {
          select: {
            isAvailable: true,
            sharingEnabled: true,
            lastLocationUpdate: true,
            accuracyMeters: true
          }
        }
      }
    });

    if (!profile) {
      return res.status(404).json({ success: false, message: 'Worker profile not found.' });
    }

    const loc = profile.locationSharing || { isAvailable: false, sharingEnabled: false, lastLocationUpdate: null, accuracyMeters: null };
    // "online" only counts while the position is fresh; a worker whose page was closed drops out of search after FRESH_MS
    const fresh = Boolean(loc.lastLocationUpdate && Date.now() - new Date(loc.lastLocationUpdate).getTime() <= AVAILABILITY_FRESH_MS);
    return res.json({ success: true, location: loc, isFresh: fresh, freshForSeconds: AVAILABILITY_FRESH_MS / 1000, maxAccuracyMeters: AVAILABILITY_MAX_ACCURACY_M });
  } catch (error) {
    console.error('[User Controller] getMyLocationSharing error:', error);
    return res.status(500).json({ success: false, message: 'Could not retrieve location-sharing settings.' });
  }
};

// Availability ("Go online") location rules. A fix this inaccurate or this old would put the worker in the wrong
// place in customers' searches, so it is refused and the worker is told why.
const AVAILABILITY_MAX_ACCURACY_M = 2000;
const AVAILABILITY_MAX_FIX_AGE_MS = 2 * 60 * 1000;
const AVAILABILITY_FRESH_MS = 15 * 60 * 1000;

exports.updateMyLocationSharing = async (req, res) => {
  try {
    const { sharingEnabled, isAvailable, latitude, longitude, accuracy, timestamp } = req.body || {};
    if (typeof sharingEnabled !== 'boolean' || typeof isAvailable !== 'boolean') {
      return res.status(400).json({ success: false, message: 'sharingEnabled and isAvailable must be booleans.' });
    }

    const profile = await prisma.workerProfile.findUnique({
      where: { userId: req.user.id },
      select: { id: true }
    });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Worker profile not found.' });
    }

    const isSharingAndAvailable = sharingEnabled && isAvailable;
    let locationData = {
      latitude: null,
      longitude: null,
      lastLocationUpdate: null,
      accuracyMeters: null
    };

    if (isSharingAndAvailable) {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const accuracyValue = accuracy === undefined || accuracy === null ? null : Number(accuracy);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ success: false, message: 'Valid latitude and longitude are required while sharing location.' });
      }
      if (accuracyValue !== null && (!Number.isFinite(accuracyValue) || accuracyValue < 0)) {
        return res.status(400).json({ success: false, code: 'BAD_ACCURACY', message: 'Location accuracy must be a non-negative number of meters.' });
      }
      if (accuracyValue !== null && accuracyValue > AVAILABILITY_MAX_ACCURACY_M) {
        return res.status(422).json({ success: false, code: 'LOW_ACCURACY', message: `Your GPS accuracy is too low (±${Math.round(accuracyValue)} m) to place you correctly for customers. Move to an open area, turn on high-accuracy location and try again.`, maxAccuracyMeters: AVAILABILITY_MAX_ACCURACY_M });
      }
      if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
        const t = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
        if (!Number.isFinite(t)) return res.status(400).json({ success: false, code: 'BAD_TIMESTAMP', message: 'Invalid location timestamp.' });
        if (Date.now() - t > AVAILABILITY_MAX_FIX_AGE_MS) {
          return res.status(422).json({ success: false, code: 'STALE_FIX', message: 'That GPS reading is too old. Please get a fresh location and try again.' });
        }
      }
      locationData = {
        latitude: lat,
        longitude: lng,
        lastLocationUpdate: new Date(),
        accuracyMeters: accuracyValue
      };
    }

    const location = await prisma.workerLocation.upsert({
      where: { workerProfileId: profile.id },
      create: {
        workerProfileId: profile.id,
        ...locationData,
        isAvailable,
        sharingEnabled
      },
      update: {
        ...locationData,
        isAvailable,
        sharingEnabled
      },
      select: {
        isAvailable: true,
        sharingEnabled: true,
        lastLocationUpdate: true,
        accuracyMeters: true
      }
    });

    // Going offline only ends marketplace availability. Journey sharing for a booking the worker is travelling to is a
    // separate, explicit act (Start journey / Pause sharing) and is not switched by this toggle.

    return res.json({ success: true, location });
  } catch (error) {
    console.error('[User Controller] updateMyLocationSharing error:', error);
    return res.status(500).json({ success: false, message: 'Could not update location-sharing settings.' });
  }
};

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const forbiddenRoleFields = ['role', 'roles', 'privileges', 'permissions', 'isAdmin', 'admin'];
    const attemptedForbiddenField = forbiddenRoleFields.find((field) => Object.prototype.hasOwnProperty.call(req.body, field));

    if (attemptedForbiddenField) {
      return res.status(400).json({
        success: false,
        message: 'Role and privilege updates are not allowed through the profile endpoint.'
      });
    }

    const { category, hourlyRate, experience, phone, skills, bio, availability, location, name } = req.body;
    // NOTE: 'rating' and 'reviewsCount' are intentionally excluded — they are managed only by reviewController.
    const userId = req.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { workerProfile: { include: { skills: true } } }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const userUpdate = {};
    if (name) userUpdate.name = String(name).trim();
    if (phone) userUpdate.phone = String(phone).trim();

    const profileUpdate = {};
    if (category) {
      const categoryRecord = await ensureCategory(category);
      profileUpdate.primaryCategoryId = categoryRecord.id;
    }
    if (hourlyRate !== undefined) profileUpdate.hourlyRate = Number(hourlyRate);
    if (bio !== undefined) profileUpdate.bio = String(bio).trim();
    if (experience !== undefined) {
      const match = String(experience).match(/\d+/);
      profileUpdate.experienceYears = match ? Number(match[0]) : 0;
    }
    if (location !== undefined) {
      profileUpdate.serviceAddress = typeof location === 'string' ? location : (location?.address || location || 'Nearby');
    }
    if (availability !== undefined) {
      profileUpdate.serviceAddress = profileUpdate.serviceAddress || String(availability).trim();
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...userUpdate,
        ...(user.workerProfile
          ? {
              workerProfile: {
                update: profileUpdate
              }
            }
          : {
              workerProfile: {
                create: {
                  ...profileUpdate,
                  primaryCategoryId: profileUpdate.primaryCategoryId || (await ensureCategory('Other')).id,
                  businessName: user.name,
                  verificationStatus: 'UNVERIFIED'
                }
              }
            })
      },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    if (Array.isArray(skills)) {
      const normalized = [...new Set(skills.map((skill) => String(skill).trim()).filter(Boolean))];
      const profileId = updatedUser.workerProfile?.id;
      if (profileId) {
        await prisma.professionalSkill.deleteMany({ where: { workerProfileId: profileId } });
        if (normalized.length > 0) {
          await prisma.professionalSkill.createMany({
            data: normalized.map((skillName) => ({ workerProfileId: profileId, skillName }))
          });
        }
      }
    }

    const refreshedUser = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    const responseUser = refreshedUser && refreshedUser.workerProfile ? formatWorker(refreshedUser, { self: true }) : {
      id: refreshedUser.id,
      _id: refreshedUser.id,
      name: refreshedUser.name,
      email: refreshedUser.email,
      role: refreshedUser.role === 'WORKER' ? 'Worker' : refreshedUser.role === 'ADMIN' ? 'Admin' : 'Customer',
      avatarUrl: refreshedUser.avatarUrl,
      phone: refreshedUser.phone,
      createdAt: refreshedUser.createdAt,
      updatedAt: refreshedUser.updatedAt
    };

    res.json({ success: true, user: responseUser });
  } catch (error) {
    console.error('[User Controller] updateProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error updating profile', error: error.message });
  }
};

exports.uploadAvatar = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: User authentication required.' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    const supabaseAdmin = supabaseConfig.supabaseAdmin;
    if (!supabaseAdmin) {
      return res.status(503).json({ success: false, message: 'Photo storage is not configured on the server.' });
    }

    // The file's own bytes decide what it is. The browser-declared Content-Type is attacker-controlled, and this bucket
    // is PUBLIC: without this check an HTML/SVG/script could be stored there under an image type.
    const detected = sniffMime(req.file.buffer);
    const mimeMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    if (!detected || !mimeMap[detected]) {
      return res.status(400).json({ success: false, message: 'The file is not a valid JPG, PNG or WebP image.' });
    }
    const fileName = `${userId}/avatar-${Date.now()}.${mimeMap[detected]}`;

    // Upload to Supabase Storage bucket 'profile-photos'
    const { error: uploadError } = await supabaseAdmin.storage
      .from('profile-photos')
      .upload(fileName, req.file.buffer, {
        contentType: detected,
        upsert: true
      });

    if (uploadError) {
      console.error('[User Controller] Supabase Storage upload error:', uploadError.message);
      return res.status(502).json({ success: false, message: 'Failed to upload photo to storage.' });
    }

    // Retrieve public URL for the uploaded photo
    const { data: urlData } = supabaseAdmin.storage
      .from('profile-photos')
      .getPublicUrl(fileName);

    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) {
      return res.status(500).json({ success: false, message: 'Could not resolve public photo URL.' });
    }

    // Update User.avatarUrl in Prisma / Supabase DB
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: publicUrl },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    const formatted = updatedUser.workerProfile ? formatWorker(updatedUser, { self: true }) : {
      id: updatedUser.id,
      _id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role === 'WORKER' ? 'Worker' : updatedUser.role === 'ADMIN' ? 'Admin' : 'Customer',
      avatarUrl: updatedUser.avatarUrl,
      phone: updatedUser.phone,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    res.json({
      success: true,
      message: 'Profile photo uploaded successfully!',
      avatarUrl: publicUrl,
      user: formatted
    });
  } catch (error) {
    console.error('[User Controller] uploadAvatar error:', error);
    res.status(500).json({ success: false, message: 'Server error processing profile photo upload' });
  }
};

exports.deleteAvatar = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: User authentication required.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
      include: {
        workerProfile: {
          include: {
            primaryCategory: true,
            skills: true
          }
        }
      }
    });

    const formatted = updatedUser.workerProfile ? formatWorker(updatedUser, { self: true }) : {
      id: updatedUser.id,
      _id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role === 'WORKER' ? 'Worker' : updatedUser.role === 'ADMIN' ? 'Admin' : 'Customer',
      avatarUrl: null,
      phone: updatedUser.phone,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    res.json({
      success: true,
      message: 'Profile photo removed successfully.',
      user: formatted
    });
  } catch (error) {
    console.error('[User Controller] deleteAvatar error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error removing profile photo',
      error: error.message
    });
  }
};
