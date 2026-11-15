// LocalHire Centralized API Client Module
// Uses bearer-token authentication over the real backend and avoids fake localStorage auth fallbacks.

const API_BASE_URL = (typeof window !== 'undefined' && window.location && window.location.origin) ? `${window.location.origin}/api` : '/api';

const getSessionStorage = () => (window.sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null));
const getLocalStorage = () => (window.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null));

const clearAuthState = () => {
  const sessionStore = getSessionStorage();
  const localStore = getLocalStorage();

  if (sessionStore) {
    sessionStore.removeItem('localHire_session');
    sessionStore.removeItem('localHire_token');
  }
  if (localStore) {
    localStore.removeItem('localHire_session');
    localStore.removeItem('localHire_token');
  }
};

const getStoredToken = () => {
  const sessionStore = getSessionStorage();
  const sessionToken = sessionStore ? sessionStore.getItem('localHire_token') : null;
  if (sessionToken) return sessionToken;

  const localStore = getLocalStorage();
  const legacyToken = localStore ? localStore.getItem('localHire_token') : null;
  if (legacyToken) {
    clearAuthState();
    return null;
  }

  return null;
};

const getAuthHeaders = () => {
  const token = getStoredToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
};

window.localHireAPI = {
  baseUrl: API_BASE_URL,
  isOnline: false,

  // Check backend server health
  checkHealth: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`, { method: 'GET' });
      if (response.ok) {
        window.localHireAPI.isOnline = true;
        return true;
      }
    } catch (e) {
      window.localHireAPI.isOnline = false;
    }
    return false;
  },

  // Auth: store a verified session (token + user) after login / verification / Google sign-in
  storeSession: (token, user) => {
    clearAuthState();
    const sessionStore = getSessionStorage();
    if (sessionStore && token && user) {
      sessionStore.setItem('localHire_session', JSON.stringify(user));
      sessionStore.setItem('localHire_token', token);
    }
  },

  // Auth: Login
  login: async (email, password) => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok && data.success && data.token) {
        window.localHireAPI.storeSession(data.token, data.user);
        return { success: true, user: data.user };
      }
      clearAuthState();
      return { success: false, message: data.message || 'Invalid credentials', code: data.code, email: data.email };
    } catch (err) {
      console.warn('[API Client] Backend unavailable. No mock authentication is created for failed login attempts.');
      clearAuthState();
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Auth: Register. Succeeds without a session: the user must verify their email first.
  register: async (userData) => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
      });
      const data = await res.json();
      clearAuthState();
      if (res.ok && data.success) {
        return { success: true, requiresEmailVerification: Boolean(data.requiresEmailVerification), email: data.email, message: data.message };
      }
      return { success: false, message: data.message || 'Registration failed', code: data.code };
    } catch (err) {
      console.warn('[API Client] Backend unavailable. Registration did not create a mock authenticated session.');
      clearAuthState();
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Auth: shared POST helper for the public email/password-recovery endpoints
  _authPost: async (path, body) => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return { ...data, success: Boolean(res.ok && data.success) };
    } catch (err) {
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Auth: complete email verification using the token from the emailed link; signs the user in
  verifyEmail: async (accessToken) => {
    const data = await window.localHireAPI._authPost('verify-email', { accessToken });
    if (data.success && data.token) {
      window.localHireAPI.storeSession(data.token, data.user);
      return { success: true, user: data.user };
    }
    return { success: false, message: data.message || 'Verification failed', code: data.code };
  },

  resendVerification: (email) => window.localHireAPI._authPost('resend-verification', { email }),

  forgotPassword: (email) => window.localHireAPI._authPost('forgot-password', { email }),

  resetPassword: (accessToken, password) => window.localHireAPI._authPost('reset-password', { accessToken, password }),

  // Auth: finish "Continue with Google" with the app token the server placed in the URL fragment
  completeOAuthLogin: async (token) => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/me`, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        window.localHireAPI.storeSession(token, data.user);
        return { success: true, user: data.user };
      }
      clearAuthState();
      return { success: false, message: data.message || 'Google sign-in could not be completed.' };
    } catch (err) {
      clearAuthState();
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Auth: URL that starts the Google flow (a full-page navigation handled by the backend)
  googleLoginUrl: (role) => `${API_BASE_URL}/auth/google${role ? `?role=${encodeURIComponent(role)}` : ''}`,

  // Auth: Get Current User Profile
  getMe: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/auth/me`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          const sessionStore = getSessionStorage();
          if (sessionStore) {
            sessionStore.setItem('localHire_session', JSON.stringify(data.user));
          }
          return data.user;
        }
      }
      clearAuthState();
      return null;
    } catch (err) {
      console.warn('[API Client] Backend unavailable. Existing auth state was cleared instead of using mock data.');
      clearAuthState();
      return null;
    }
  },

  // User / Profile: Update Profile
  updateProfile: async (updates) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/profile`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          const sessionStore = getSessionStorage();
          if (sessionStore) {
            sessionStore.setItem('localHire_session', JSON.stringify(data.user));
          }
          return { success: true, user: data.user };
        }
      }
      return { success: false, message: 'Could not update profile' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable. No mock profile update was applied.');
      return { success: false, message: 'Could not update profile' };
    }
  },

  getMyLocationSharing: async () => {
    const res = await fetch(`${API_BASE_URL}/users/location`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not retrieve location-sharing settings.');
    return data.location;
  },

  updateMyLocationSharing: async (locationSettings) => {
    const res = await fetch(`${API_BASE_URL}/users/location`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(locationSettings)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not update location-sharing settings.');
    return data.location;
  },

  getCurrentLocation: async () => {
    const res = await fetch(`${API_BASE_URL}/users/current-location`, { headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not retrieve your selected location.');
    return data.location;
  },

  saveCurrentLocation: async (location) => {
    const res = await fetch(`${API_BASE_URL}/users/current-location`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify(location)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not save your selected location.');
    return data.location;
  },

  // User / Profile: Upload Avatar (Customer and Worker)
  uploadAvatar: async (file) => {
    try {
      const token = getStoredToken();
      const formData = new FormData();
      formData.append('avatar', file);

      const res = await fetch(`${API_BASE_URL}/users/avatar`, {
        method: 'POST',
        headers: {
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          // Content-Type is intentionally omitted so the browser sets the multipart boundary
        },
        body: formData
      });

      const data = await res.json();
      if (res.ok && data.success) {
        if (data.user) {
          const sessionStore = getSessionStorage();
          if (sessionStore) {
            sessionStore.setItem('localHire_session', JSON.stringify(data.user));
          }
        }
        return { success: true, avatarUrl: data.avatarUrl, user: data.user, message: data.message };
      }
      return { success: false, message: data.message || 'Avatar upload failed.' };
    } catch (err) {
      console.error('[API Client] uploadAvatar error:', err);
      return { success: false, message: 'Unable to reach the server to upload photo.' };
    }
  },

  // User / Profile: Delete Avatar
  deleteAvatar: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/avatar`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.user) {
          const sessionStore = getSessionStorage();
          if (sessionStore) {
            sessionStore.setItem('localHire_session', JSON.stringify(data.user));
          }
        }
        return { success: true, user: data.user, message: data.message };
      }
      return { success: false, message: data.message || 'Avatar removal failed.' };
    } catch (err) {
      console.error('[API Client] deleteAvatar error:', err);
      return { success: false, message: 'Unable to reach the server to remove photo.' };
    }
  },

  getAddresses: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/addresses`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, addresses: data.addresses || [] };
      }
      return { success: false, message: data.message || 'Unable to load addresses.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while loading saved addresses.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  createAddress: async (addressData) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/addresses`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(addressData)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, address: data.address };
      }
      return { success: false, message: data.message || 'Address could not be saved.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while creating address.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  updateAddress: async (addressId, addressData) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/addresses/${addressId}`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify(addressData)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, address: data.address };
      }
      return { success: false, message: data.message || 'Address could not be updated.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while updating address.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  setDefaultAddress: async (addressId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/addresses/${addressId}/default`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, address: data.address };
      }
      return { success: false, message: data.message || 'Default address could not be updated.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while updating default address.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  deleteAddress: async (addressId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/addresses/${addressId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true };
      }
      return { success: false, message: data.message || 'Address could not be deleted.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while deleting address.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Journey tracking moved to js/tracking.js (booking-scoped, participant-checked, honest about staleness).

  // Workers / Search (Restricted to Customer / Hire Worker accounts)
  getWorkers: async (queryFilters = {}) => {
    try {
      const queryStr = new URLSearchParams(queryFilters).toString();
      const res = await fetch(`${API_BASE_URL}/users/workers?${queryStr}`, {
        headers: getAuthHeaders()
      });
      if (res.status === 403) {
        console.warn('[API Client] Access forbidden: Worker accounts cannot access the worker directory.');
        return [];
      }
      if (res.ok) {
        const data = await res.json();
        return data.workers || [];
      }
    } catch (err) {
      console.warn('[API Client] Server offline, checking permissions for local workers');
    }
    // The server is the only source of discoverable workers (it enforces verification). No local fallback.
    return [];
  },

  getWorkerById: async (id) => {
    try {
      const res = await fetch(`${API_BASE_URL}/users/workers/${id}`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        return data.worker;
      }
    } catch (err) {
      console.warn('[API Client] Could not load the worker profile from the server.');
    }
    return null;
  },

  // Jobs
  getJobs: async (queryFilters = {}) => {
    try {
      const queryStr = new URLSearchParams(queryFilters).toString();
      // The token (when signed in) lets the server mark the caller's own jobs. Everyone else gets jobs without poster identity.
      const jobsToken = getStoredToken();
      const res = await fetch(`${API_BASE_URL}/jobs?${queryStr}`, jobsToken ? { headers: { Authorization: `Bearer ${jobsToken}` } } : undefined);
      if (res.ok) {
        const data = await res.json();
        return data.jobs;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, returning local jobs');
    }
    let jobs = window.localHireApp.getJobs();
    if (queryFilters.category) {
      jobs = jobs.filter(j => j.category === queryFilters.category);
    }
    if (queryFilters.q) {
      const q = queryFilters.q.toLowerCase();
      jobs = jobs.filter(j => j.title.toLowerCase().includes(q) || j.description.toLowerCase().includes(q));
    }
    return jobs;
  },

  getJobById: async (id) => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/${id}`);
      if (res.ok) {
        const data = await res.json();
        return data.job;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, returning local job');
    }
    const jobs = window.localHireApp.getJobs();
    return jobs.find(j => j.id === id);
  },

  saveJob: async (jobData) => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(jobData)
      });
      if (res.ok) {
        const data = await res.json();
        window.localHireApp.saveJob(data.job);
        return data.job;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, saving job locally');
    }
    window.localHireApp.saveJob(jobData);
    return jobData;
  },

  updateJobStatus: async (jobId, status, assignedWorkerId = null) => {
    try {
      const res = await fetch(`${API_BASE_URL}/jobs/${jobId}/status`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ status, assignedWorkerId })
      });
      if (res.ok) {
        const data = await res.json();
        return data.job;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, updating job status locally');
    }
    const jobs = window.localHireApp.getJobs();
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      job.status = status;
      if (assignedWorkerId) job.assignedWorker = assignedWorkerId;
      localStorage.setItem('localHire_jobs', JSON.stringify(jobs));
    }
    return job;
  },

  // Bookings (Customer to Worker Direct Hire — PostgreSQL / Prisma Persistence)
  createBooking: async (bookingData) => {
    try {
      const res = await fetch(`${API_BASE_URL}/bookings`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(bookingData)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, booking: data.booking, message: data.message };
      } else {
        return {
          success: false,
          message: data.message || 'Booking request failed on server',
          details: data.details || null,
          error: data.error || null
        };
      }
    } catch (err) {
      console.error('[API Client] Server connection failed during booking:', err);
      return {
        success: false,
        message: 'Could not connect to the API server. Please verify the backend is running and PostgreSQL is connected.'
      };
    }
  },

  getMyBookings: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/bookings/my`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, bookings: data.bookings || [] };
      } else {
        return {
          success: false,
          bookings: [],
          message: data.message || 'Could not retrieve bookings from database'
        };
      }
    } catch (err) {
      console.warn('[API Client] Server connection failed when retrieving bookings:', err);
      return {
        success: false,
        bookings: [],
        message: 'Database unavailable: Server is offline or PostgreSQL is not connected.'
      };
    }
  },

  getBookingById: async (bookingId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/bookings/${bookingId}`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, booking: data.booking };
      }
      return { success: false, message: data.message };
    } catch (err) {
      return { success: false, message: 'Database connection unavailable' };
    }
  },

  updateBookingStatus: async (bookingId, status, notes = '', extra = {}) => {
    try {
      const res = await fetch(`${API_BASE_URL}/bookings/${bookingId}/status`, {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ ...extra, status, notes })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, booking: data.booking, message: data.message, refund: data.refund };
      }
      return { success: false, message: data.message || 'Status update failed' };
    } catch (err) {
      return { success: false, message: 'Database connection unavailable' };
    }
  },

  // Applications / Quotes
  createApplication: async (jobId, quote, message) => {
    try {
      const res = await fetch(`${API_BASE_URL}/applications`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ jobId, job: jobId, quote, message })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        window.localHireApp.saveApplication(data.application);
        return { success: true, application: data.application };
      } else if (data.message) {
        return { success: false, message: data.message };
      }
    } catch (err) {
      console.warn('[API Client] Server offline, applying locally');
    }
    const currentUser = window.localHireApp.getCurrentUser();
    const appData = {
      jobId,
      workerId: currentUser ? currentUser.id : 'w_guest',
      workerName: currentUser ? currentUser.name : 'Guest Worker',
      workerAvatar: currentUser ? currentUser.avatarUrl : '',
      quote,
      message,
      status: 'Pending'
    };
    window.localHireApp.saveApplication(appData);
    return { success: true, application: appData };
  },

  getApplicationsForJob: async (jobId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/applications/job/${jobId}`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        return data.applications;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, getting applications locally');
    }
    return window.localHireApp.getApplicationsForJob(jobId);
  },

  getWorkerApplications: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/applications/worker/me`, {
        headers: getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        return data.applications;
      }
    } catch (err) {
      console.warn('[API Client] Server offline, getting worker applications locally');
    }
    const currentUser = window.localHireApp.getCurrentUser();
    return currentUser ? window.localHireApp.getApplicationsForWorker(currentUser.id) : [];
  },

  // The quote creates a price-confirmed booking on the server; there is no offline/local fallback for money flows.
  acceptQuote: async (applicationId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/applications/${applicationId}/accept`, {
        method: 'PUT',
        headers: getAuthHeaders()
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { success: true, message: data.message, bookingId: data.bookingId || null };
      return { success: false, message: data.message || 'Could not accept this quote.' };
    } catch (err) {
      return { success: false, message: 'Could not reach LocalHire. Please try again.' };
    }
  },

  // Chat / Messages
  sendMessage: async (receiverId, content) => {
    try {
      const res = await fetch(`${API_BASE_URL}/chat/messages`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ receiverId, content })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, message: data.message };
      }
      return { success: false, message: data.message || 'Unable to send message.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while sending message.');
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  getMessages: async (otherUserId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/chat/messages/${otherUserId}`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, messages: data.messages || [] };
      }
      return { success: false, messages: [], message: data.message || 'Unable to load chat history.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while loading messages.');
      return { success: false, messages: [], message: 'Unable to reach the LocalHire server.' };
    }
  },

  getConversations: async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/chat/conversations`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, conversations: data.conversations || [], count: data.count || 0 };
      }
      return { success: false, conversations: [], message: data.message || 'Unable to load conversations.' };
    } catch (err) {
      console.warn('[API Client] Backend unavailable while loading conversations.');
      return { success: false, conversations: [], message: 'Unable to reach the LocalHire server.' };
    }
  },

  markConversationAsRead: async (conversationIdOrUserId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/chat/conversations/${conversationIdOrUserId}/read`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, markedCount: data.markedCount };
      }
      return { success: false, message: data.message };
    } catch (err) {
      console.warn('[API Client] Error marking conversation as read:', err.message);
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  getChatUser: async (userId) => {
    try {
      const res = await fetch(`${API_BASE_URL}/chat/user/${userId}`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (res.ok && data.success) {
        return { success: true, user: data.user };
      }
      return { success: false, message: data.message || 'User not found.' };
    } catch (err) {
      console.warn('[API Client] Error fetching chat user info:', err.message);
      return { success: false, message: 'Unable to reach the LocalHire server.' };
    }
  },

  // Reviews: only ever real, server-stored reviews. There is no offline/local stand-in.
  // A review belongs to one completed booking and can be written once, by the customer who made it.
  createReview: async (bookingId, rating, comment) => {
    try {
      const data = await window.localHireAPI._json('/reviews', 'POST', { bookingId, rating, comment });
      return { success: true, review: data.review, summary: data.summary, updatedRating: data.updatedRating };
    } catch (err) {
      if (err.status) return { success: false, status: err.status, code: err.data && err.data.code, message: err.message };
      console.warn('[API Client] Could not reach the server to save the review:', err);
      return { success: false, message: 'Unable to reach the LocalHire server. Your review was not saved.' };
    }
  },

  getWorkerReviews: async (workerId, params = {}) => {
    try {
      const q = new URLSearchParams(params).toString();
      const res = await fetch(`${API_BASE_URL}/reviews/worker/${encodeURIComponent(workerId)}${q ? `?${q}` : ''}`);
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('[API Client] Could not load reviews:', err);
    }
    return { reviews: [], count: 0, summary: { count: 0, average: null, distribution: {} } };
  },

  getReceivedReviews: (params = {}) => window.localHireAPI._json(`/reviews/received?${new URLSearchParams(params).toString()}`),
  reportReview: (reviewId, reason, details) => window.localHireAPI._json(`/reviews/${encodeURIComponent(reviewId)}/report`, 'POST', { reason, details }),

  // ── Categories (database-driven; one source for every dropdown/filter) ─────
  getCategories: async () => {
    if (window.__lhCategoriesCache) return window.__lhCategoriesCache;
    const res = await fetch(`${API_BASE_URL}/categories`);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || 'Could not load categories');
    window.__lhCategoriesCache = data.categories;
    return data.categories;
  },

  // ── Worker onboarding, documents & dashboard ───────────────────────────────
  _json: async (path, method = 'GET', body) => {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: getAuthHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      const err = new Error(data.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  getWorkerStatus: () => window.localHireAPI._json('/worker/status'),
  getWorkerOnboarding: async () => (await window.localHireAPI._json('/worker/onboarding')).onboarding,
  saveWorkerOnboardingStep: (step, data, complete) => window.localHireAPI._json(`/worker/onboarding/step/${step}`, 'PUT', { data, complete: Boolean(complete) }),
  submitWorkerOnboarding: (declaration) => window.localHireAPI._json('/worker/onboarding/submit', 'POST', { declaration: Boolean(declaration) }),
  deleteWorkerDocument: (id) => window.localHireAPI._json(`/worker/onboarding/documents/${encodeURIComponent(id)}`, 'DELETE'),
  getWorkerDashboard: () => window.localHireAPI._json('/worker/dashboard'),

  uploadWorkerDocument: async (type, file) => {
    const token = getStoredToken();
    const form = new FormData();
    form.append('type', type);
    form.append('file', file);
    const res = await fetch(`${API_BASE_URL}/worker/onboarding/documents`, {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.message || 'Upload failed');
    return data.document;
  },

  // ── Admin: worker verification ─────────────────────────────────────────────
  getWorkerVerifications: async (params = {}) => {
    const clean = {};
    Object.keys(params).forEach((k) => { if (params[k] !== undefined && params[k] !== null && params[k] !== '') clean[k] = params[k]; });
    const q = new URLSearchParams(clean).toString();
    return window.localHireAPI._json(`/admin/worker-verifications${q ? '?' + q : ''}`);
  },
  getWorkerVerification: async (userId) => (await window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}`)).submission,
  getWorkerDocumentUrl: (userId, docId) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/documents/${encodeURIComponent(docId)}/url`),
  reviewWorkerDocument: (userId, docId, status, reason) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/documents/${encodeURIComponent(docId)}`, 'PATCH', { status, reason }),
  startWorkerReview: (userId) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/start-review`, 'POST', {}),
  approveWorker: (userId, notes) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/approve`, 'POST', { notes }),
  rejectWorker: (userId, reason) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/reject`, 'POST', { reason }),
  requestWorkerResubmission: (userId, reason, documentIds) => window.localHireAPI._json(`/admin/worker-verifications/${encodeURIComponent(userId)}/request-resubmission`, 'POST', { reason, documentIds }),

  // Admin Portal API
  getAdminMetrics: async () => {
    const res = await fetch(`${API_BASE_URL}/admin/metrics`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data.metrics;
    }
    throw new Error(data.message || 'Failed to fetch admin metrics');
  },

  getAdminUsers: async (params = {}) => {
    const cleanParams = {};
    Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        cleanParams[k] = params[k];
      }
    });
    const query = new URLSearchParams(cleanParams).toString();
    const url = `${API_BASE_URL}/admin/users${query ? '?' + query : ''}`;
    const res = await fetch(url, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to fetch admin users');
  },

  verifyAdminUser: async (userId, status = 'VERIFIED', notes = '') => {
    const res = await fetch(`${API_BASE_URL}/admin/users/${userId}/verify`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ status, notes })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to update user verification');
  },

  deleteAdminUser: async (userId) => {
    const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to delete user');
  },

  getAdminJobs: async (params = {}) => {
    const cleanParams = {};
    Object.keys(params).forEach(k => {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        cleanParams[k] = params[k];
      }
    });
    const query = new URLSearchParams(cleanParams).toString();
    const url = `${API_BASE_URL}/admin/jobs${query ? '?' + query : ''}`;
    const res = await fetch(url, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to fetch admin jobs');
  },

  flagAdminJob: async (jobId, reason = '', isFlagged = true) => {
    const res = await fetch(`${API_BASE_URL}/admin/jobs/${jobId}/flag`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ reason, isFlagged })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to flag job');
  },

  deleteAdminJob: async (jobId) => {
    const res = await fetch(`${API_BASE_URL}/admin/jobs/${jobId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (res.ok && data.success) {
      return data;
    }
    throw new Error(data.message || 'Failed to delete job');
  },
};

// Check backend status on script load
window.localHireAPI.checkHealth();

// Fills a <select> from the database-driven category list. Existing options are kept as a fallback
// if the request fails; `keep` options (e.g. "All Categories") stay at the top.
window.localHireCategories = {
  fill: async (select, { keepFirst = 1, valueKey = 'name', selected = '' } = {}) => {
    if (!select) return;
    try {
      const categories = await window.localHireAPI.getCategories();
      const kept = Array.from(select.options).slice(0, keepFirst);
      select.innerHTML = '';
      kept.forEach((o) => select.appendChild(o));
      categories.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c[valueKey];
        opt.textContent = c.name;
        select.appendChild(opt);
      });
      if (selected) select.value = selected;
    } catch (e) {
      console.warn('[Categories] Using the page defaults because the list could not be loaded:', e.message);
    }
  }
};
