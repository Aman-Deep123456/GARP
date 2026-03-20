import { http, HttpResponse } from 'msw';

const mockWorker = {
  worker_id: 'GIG_0001',
  name: 'Rajesh Sharma',
  phone: '+919876543210',
  email: 'gig_0001@grap.demo',
  platform: 'zomato',
  ward_id: 'MUM_KURLA_W12',
  city: 'Mumbai',
  vehicle_type: 'motorcycle',
  tenure_weeks: 42,
  avg_deliv_dist_km: 3.5,
  peak_hour_share: 0.65,
  productivity_score: 0.82,
  hist_disrupt_days_52wk: 7,
  policy: {
    active: true,
    weekly_premium: 28,
    sum_insured: 2500,
    start_date: '2025-06-01T00:00:00Z',
    end_date: '2026-06-01T00:00:00Z',
  },
  telemetry_paused: false,
  created_at: '2025-06-01T00:00:00Z',
};

const mockClaims = [
  {
    claim_id: 'CLM-A1B2C3D4',
    worker_id: 'GIG_0001',
    ward_id: 'MUM_KURLA_W12',
    state: 'SETTLED',
    risk_score: 0.91,
    payout_amount: 133.93,
    hours_disrupted: 3.07,
    fraud_verdict: 'PASS',
    fraud_score: 0.22,
    settled_at: '2026-03-15T14:30:00Z',
    created_at: '2026-03-15T12:00:00Z',
    transitions: [
      { from: 'ACTIVE', to: 'INITIATED', timestamp: '2026-03-15T12:00:00Z', reason: 'Rt=0.91 > 0.85 for 60min' },
      { from: 'INITIATED', to: 'VALIDATING', timestamp: '2026-03-15T12:01:00Z', reason: 'Duration confirmed' },
      { from: 'VALIDATING', to: 'READY_PAY', timestamp: '2026-03-15T12:02:00Z', reason: 'Fraud PASS (F=0.22)' },
      { from: 'READY_PAY', to: 'PROCESSING', timestamp: '2026-03-15T12:02:30Z', reason: 'Payout command issued' },
      { from: 'PROCESSING', to: 'SETTLED', timestamp: '2026-03-15T14:30:00Z', reason: 'Payment successful' },
    ],
  },
  {
    claim_id: 'CLM-E5F6G7H8',
    worker_id: 'GIG_0001',
    ward_id: 'MUM_KURLA_W12',
    state: 'INITIATED',
    risk_score: 0.88,
    payout_amount: null,
    created_at: '2026-03-18T08:00:00Z',
    transitions: [
      { from: 'ACTIVE', to: 'INITIATED', timestamp: '2026-03-18T08:00:00Z', reason: 'Rt=0.88 > 0.85' },
    ],
  },
  {
    claim_id: 'CLM-I9J0K1L2',
    worker_id: 'GIG_0001',
    ward_id: 'MUM_ANDHERI_W58',
    state: 'REJECTED',
    risk_score: 0.87,
    fraud_verdict: 'FAIL',
    fraud_score: 0.82,
    rejected_at: '2026-03-10T16:00:00Z',
    created_at: '2026-03-10T14:00:00Z',
    transitions: [
      { from: 'ACTIVE', to: 'INITIATED', timestamp: '2026-03-10T14:00:00Z' },
      { from: 'INITIATED', to: 'VALIDATING', timestamp: '2026-03-10T14:01:00Z' },
      { from: 'VALIDATING', to: 'REJECTED', timestamp: '2026-03-10T16:00:00Z', reason: 'Fraud FAIL (F=0.82)' },
    ],
  },
];

const mockWorkersList = Array.from({ length: 50 }, (_, i) => ({
  worker_id: `GIG_${String(i + 1).padStart(4, '0')}`,
  name: `Worker ${i + 1}`,
  phone: `+91${9000000000 + i}`,
  platform: ['zomato', 'swiggy', 'both'][i % 3],
  ward_id: ['MUM_KURLA_W12', 'MUM_ANDHERI_W58', 'MUM_BANDRA_W43', 'MUM_DADAR_W25', 'MUM_POWAI_W91'][i % 5],
  city: 'Mumbai',
  policy: { active: true, weekly_premium: 12 + (i % 44), sum_insured: [2000, 2500, 3000][i % 3] },
  tenure_weeks: 10 + i,
  created_at: new Date(Date.now() - i * 86400000).toISOString(),
}));

export const handlers = [
  // Auth
  http.post('/v1/auth/login', async () => {
    return HttpResponse.json({ worker: mockWorker, token: 'mock-jwt-token-12345' });
  }),
  http.post('/v1/auth/register', async () => {
    return HttpResponse.json({ worker: mockWorker, token: 'mock-jwt-token-12345' }, { status: 201 });
  }),
  http.post('/v1/auth/admin/login', async () => {
    return HttpResponse.json({ token: 'mock-admin-jwt-token', role: 'admin' });
  }),
  http.get('/v1/auth/me', () => HttpResponse.json(mockWorker)),

  // Workers
  http.get('/v1/workers/:id', ({ params }) =>
    HttpResponse.json({ ...mockWorker, worker_id: params.id as string })
  ),
  http.get('/v1/workers/:id/policy', ({ params }) =>
    HttpResponse.json({
      worker_id: params.id,
      name: mockWorker.name,
      ward_id: mockWorker.ward_id,
      ...mockWorker.policy,
    })
  ),
  http.get('/v1/workers', () =>
    HttpResponse.json({ workers: mockWorkersList, total: 500, page: 1, limit: 50 })
  ),

  // Claims
  http.get('/v1/claims/:workerId', () =>
    HttpResponse.json({ claims: mockClaims, total: mockClaims.length })
  ),
  http.get('/v1/claims', () =>
    HttpResponse.json({ claims: mockClaims, total: mockClaims.length, page: 1, limit: 50 })
  ),

  // Telemetry
  http.post('/v1/telemetry', async () => {
    return HttpResponse.json({
      status: 'accepted',
      worker_id: 'GIG_0001',
      timestamp: new Date().toISOString(),
    });
  }),
];
