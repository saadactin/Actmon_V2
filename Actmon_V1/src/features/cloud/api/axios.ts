import axios from 'axios';

// Get the base URL from environment variables, or fallback to relative path which Vite will proxy
const baseURL = import.meta.env.VITE_CLOUD_API 
  ? `${import.meta.env.VITE_CLOUD_API}/api/v1/cloud` 
  : '/api/v1/cloud';

export const cloudAxios = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Optional: Add request/response interceptors here if needed for auth tokens
