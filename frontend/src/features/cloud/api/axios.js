import axios from 'axios';

// Separate microservice (its own auth domain), so this is its own axios
// instance rather than the app-wide `client` — same as the original module.
// Optional-chained so the module can also be imported outside Vite — node has
// no `import.meta.env`, and the test suites import the API layer to check that
// the filter wire format round-trips.
const baseURL = import.meta.env?.VITE_CLOUD_API
  ? `${import.meta.env.VITE_CLOUD_API}/api/v1/cloud`
  : '/api/v1/cloud';

export const cloudAxios = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});
