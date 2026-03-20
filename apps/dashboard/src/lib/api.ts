import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor — attach JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('grap_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — handle errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('grap_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ── API Functions ────────────────────────────────────
export const authAPI = {
  login: (data: { worker_id: string; phone: string }) =>
    api.post('/v1/auth/login', data),
  register: (data: Record<string, unknown>) =>
    api.post('/v1/auth/register', data),
  adminLogin: (data: { username: string; password: string }) =>
    api.post('/v1/auth/admin/login', data),
  me: () => api.get('/v1/auth/me'),
};

export const workerAPI = {
  get: (id: string) => api.get(`/v1/workers/${id}`),
  getPolicy: (id: string) => api.get(`/v1/workers/${id}/policy`),
  list: (params?: Record<string, string>) => api.get('/v1/workers', { params }),
  updateSettings: (id: string, data: Record<string, unknown>) =>
    api.put(`/v1/workers/${id}/settings`, data),
};

export const claimsAPI = {
  getByWorker: (workerId: string) => api.get(`/v1/claims/${workerId}`),
  get: (workerId: string, claimId: string) =>
    api.get(`/v1/claims/${workerId}/${claimId}`),
  list: (params?: Record<string, string>) => api.get('/v1/claims', { params }),
};

export const telemetryAPI = {
  post: (data: Record<string, unknown>) => api.post('/v1/telemetry', data),
};

export default api;
