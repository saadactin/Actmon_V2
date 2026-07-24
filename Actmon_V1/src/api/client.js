import axios from 'axios';

// Since we proxy '/api' to 'http://192.168.8.100:8000', we can use '/api/v1' as baseURL
// Or if the backend endpoints are /api/v1/..., we use '/api/v1'
// The prompt states: FastAPI backend at http://192.168.8.100:8000
// And mentions: GET /api/v1/agents/
// So our baseURL is '/api/v1' (Vite proxy redirects /api to the FastAPI backend)
const client = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  // Axios has no default timeout (0 = wait forever). A dashboard tab whose data
  // isn't cache-warm yet falls through to a live query over the agent's job
  // channel — if that channel is ever genuinely stuck, the request (and the
  // loading spinner) would otherwise hang indefinitely with no feedback at all.
  timeout: 30000,
});

// Request interceptor: Attach JWT token if it exists
client.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('actmon_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: Handle 401 Unauthorized redirects and display errors
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const { status } = error.response;
      if (status === 401) {
        console.warn('Unauthorized (401) response received from backend. Local session kept active for resilience.');
      }
      
      // Access Denied (403)
      if (status === 403) {
        console.error('Access Denied (403): User lacks permissions.');
      }
      
      const serverMessage = error.response.data?.detail || error.response.data?.message || 'Server error occurred.';
      return Promise.reject(new Error(serverMessage));
    } else if (error.code === 'ECONNABORTED') {
      // Our own client-side timeout (30s) firing — distinct from a genuine
      // network failure, so it gets its own message rather than "cannot reach server".
      return Promise.reject(new Error('The server took too long to respond. It may still be collecting data for this connection — try again in a moment.'));
    } else if (error.request) {
      // Network error (no response received)
      return Promise.reject(new Error('Cannot reach server. Please check your network connection.'));
    } else {
      // Something happened in setting up the request
      return Promise.reject(new Error(error.message || 'An unexpected error occurred.'));
    }
  }
);

export function ensureArray(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) {
      return data.data;
    }
    if (Array.isArray(data.agents)) {
      return data.agents;
    }
    if (Array.isArray(data.results)) {
      return data.results;
    }
    if (Array.isArray(data.items)) {
      return data.items;
    }
    if (Array.isArray(data.notifications)) {
      return data.notifications;
    }
  }
  return [];
}

export default client;

