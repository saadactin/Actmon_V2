import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { useAuth } from '../hooks/useAuth';
import { Button, Input, Field, Spinner, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { Eye, EyeOff, Shield } from 'lucide-react';

const loginSchema = zod.object({
  username: zod.string().min(3, 'Username must be at least 3 characters'),
  password: zod.string().min(5, 'Password must be at least 5 characters'),
});

export const Login = () => {
  const { login, loading, error: authError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [showPassword, setShowPassword] = useState(false);

  const isExpired = searchParams.get('expired') === 'true';

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  const onSubmit = async (data) => {
    const success = await login(data.username, data.password);
    if (success) {
      navigate('/dashboard');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8 bg-white p-8 rounded-lg shadow-card border border-brand-border animate-in fade-in zoom-in-95 duration-200">
        <div className="flex flex-col items-center">
          <div className="flex items-center justify-center bg-[#0078D4] p-3 rounded-xl mb-3 shadow-md">
            <Shield className="h-8 w-8 text-white" />
          </div>
          <h2 className="mt-2 text-center text-3xl font-extrabold text-brand-text-primary tracking-tight">
            ActMon Platform
          </h2>
          <p className="mt-1.5 text-center text-sm text-brand-text-secondary">
            Oracle & Multi-Database Monitoring Portal
          </p>
        </div>

        {isExpired && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Session Expired</MessageBarTitle>
              Your session has expired. Please log in again to continue.
            </MessageBarBody>
          </MessageBar>
        )}

        {authError && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Login Failed</MessageBarTitle>
              {authError}
            </MessageBarBody>
          </MessageBar>
        )}

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <Field
              label="Username"
              validationState={errors.username ? 'error' : 'none'}
              validationMessage={errors.username?.message}
            >
              <Input
                {...register('username')}
                disabled={loading}
                className="w-full"
                placeholder="Enter username"
              />
            </Field>

            <Field
              label="Password"
              validationState={errors.password ? 'error' : 'none'}
              validationMessage={errors.password?.message}
            >
              <div className="relative flex items-center">
                <Input
                  {...register('password')}
                  type={showPassword ? 'text' : 'password'}
                  disabled={loading}
                  className="w-full pr-10"
                  placeholder="Enter password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 text-gray-400 hover:text-gray-600 transition-colors focus:outline-none z-10"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </Field>
          </div>

          <div>
            <Button
              type="submit"
              disabled={loading}
              appearance="primary"
              className="w-full py-2.5 font-semibold text-sm"
              style={{ width: '100%', height: '40px' }}
            >
              {loading ? <Spinner size="tiny" label="Signing in..." /> : 'Sign In'}
            </Button>
          </div>
        </form>

        <div className="mt-4 text-center">
          <p className="text-xs text-brand-text-disabled">
            ActMon Enterprise Security v2026.1. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
};
