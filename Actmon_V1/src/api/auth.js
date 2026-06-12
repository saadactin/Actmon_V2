import client from './client';
export const login = async (username, password) => {
  // Try sending as JSON first, since the prompt specifies POST /api/v1/auth/login with { username, password }
  const response = await client.post('/auth/login', {
    username,
    password,
  });
  return response.data;
};

export const getMe = async () => {
  // Fetch current user details
  const response = await client.get('/auth/me');
  return response.data;
};
