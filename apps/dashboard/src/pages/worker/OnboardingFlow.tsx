import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { authAPI } from '../../lib/api';
import { useWorkerStore } from '../../stores';
import { cn } from '../../lib/utils';
import toast from 'react-hot-toast';
import { UserPlus, ChevronRight, Check, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const schema = z.object({
  worker_id: z.string().min(3, 'Worker ID must be at least 3 characters'),
  name: z.string().min(2, 'Name is required'),
  phone: z.string().regex(/^\+91\d{10}$/, 'Enter valid Indian phone (+91XXXXXXXXXX)'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  platform: z.enum(['zomato', 'swiggy', 'both']),
  ward_id: z.string().min(1, 'Select your ward'),
  vehicle_type: z.enum(['bicycle', 'motorcycle', 'scooter']),
});

type FormData = z.infer<typeof schema>;

const STEPS = ['Identity', 'Platform', 'Coverage'];
const WARDS = [
  { value: 'MUM_KURLA_W12', label: 'Kurla West (W12)' },
  { value: 'MUM_ANDHERI_W58', label: 'Andheri West (W58)' },
  { value: 'MUM_BANDRA_W43', label: 'Bandra West (W43)' },
  { value: 'MUM_DADAR_W25', label: 'Dadar (W25)' },
  { value: 'MUM_POWAI_W91', label: 'Powai (W91)' },
];

export default function OnboardingFlow() {
  const [step, setStep] = useState(0);
  const setWorker = useWorkerStore((s) => s.setWorker);
  const navigate = useNavigate();

  const { register, handleSubmit, formState: { errors }, trigger, watch } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { platform: 'zomato', vehicle_type: 'motorcycle', ward_id: '' },
  });

  const onSubmit = async (data: FormData) => {
    try {
      const res = await authAPI.register(data);
      setWorker(res.data.worker, res.data.token);
      toast.success('Welcome to GRAP! Coverage is now active.');
      navigate('/');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Registration failed');
    }
  };

  const nextStep = async () => {
    const fieldsPerStep = [['worker_id', 'name', 'phone'], ['platform', 'ward_id', 'vehicle_type'], []] as const;
    const isValid = await trigger(fieldsPerStep[step] as any);
    if (isValid) setStep((s) => Math.min(s + 1, 2));
  };

  const renderField = (name: keyof FormData, label: string, type = 'text', placeholder = '') => (
    <div className="space-y-1.5">
      <label htmlFor={name} className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        id={name}
        type={type}
        placeholder={placeholder}
        {...register(name)}
        className={cn(
          'w-full px-3 py-2.5 rounded-lg border bg-background text-sm transition-colors focus:ring-2 focus:ring-primary focus:border-transparent outline-none',
          errors[name] ? 'border-red-500' : 'border-border'
        )}
      />
      {errors[name] && <p className="text-[10px] text-red-400">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <UserPlus className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Join GRAP</h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2 flex-1">
            <div className={cn(
              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors',
              i < step ? 'bg-primary text-primary-foreground' :
              i === step ? 'bg-primary/20 text-primary border-2 border-primary' :
              'bg-muted text-muted-foreground'
            )}>
              {i < step ? <Check className="w-3 h-3" /> : i + 1}
            </div>
            <span className={cn('text-xs', i === step ? 'text-foreground font-medium' : 'text-muted-foreground')}>{s}</span>
            {i < STEPS.length - 1 && <div className={cn('flex-1 h-px', i < step ? 'bg-primary' : 'bg-border')} />}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {step === 0 && (
          <div className="space-y-4 animate-slide-up">
            {renderField('worker_id', 'Worker ID', 'text', 'GIG_0001')}
            {renderField('name', 'Full Name', 'text', 'Rajesh Sharma')}
            {renderField('phone', 'Phone Number', 'tel', '+919876543210')}
            {renderField('email', 'Email (optional)', 'email', 'your@email.com')}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4 animate-slide-up">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Platform</label>
              <div className="grid grid-cols-3 gap-2">
                {(['zomato', 'swiggy', 'both'] as const).map((p) => (
                  <label key={p} className={cn(
                    'flex items-center justify-center py-2.5 rounded-lg border cursor-pointer text-sm font-medium transition-all',
                    watch('platform') === p ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/50'
                  )}>
                    <input type="radio" value={p} {...register('platform')} className="sr-only" />
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ward_id" className="text-xs font-medium text-muted-foreground">Ward Zone</label>
              <select id="ward_id" {...register('ward_id')} className="w-full px-3 py-2.5 rounded-lg border border-border bg-background text-sm">
                <option value="">Select your ward</option>
                {WARDS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
              {errors.ward_id && <p className="text-[10px] text-red-400">{errors.ward_id.message}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Vehicle</label>
              <div className="grid grid-cols-3 gap-2">
                {(['bicycle', 'motorcycle', 'scooter'] as const).map((v) => (
                  <label key={v} className={cn(
                    'flex items-center justify-center py-2.5 rounded-lg border cursor-pointer text-sm font-medium transition-all',
                    watch('vehicle_type') === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/50'
                  )}>
                    <input type="radio" value={v} {...register('vehicle_type')} className="sr-only" />
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 animate-slide-up">
            <div className="rounded-xl bg-gradient-to-br from-emerald-600/20 to-teal-600/20 border border-emerald-500/30 p-5 text-center">
              <Shield className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
              <h3 className="text-lg font-bold">Income Protection Ready</h3>
              <p className="text-sm text-muted-foreground mt-1">₹12-55/week dynamic premium</p>
              <p className="text-sm text-muted-foreground">Up to ₹2,500 weekly coverage</p>
            </div>
            <button type="submit" className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all">
              Activate Coverage
            </button>
          </div>
        )}

        {step < 2 && (
          <button type="button" onClick={nextStep} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-all">
            Continue <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </form>
    </div>
  );
}
