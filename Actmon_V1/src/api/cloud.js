import client, { ensureArray } from './client';

// GET /api/v1/cloud/accounts/?provider={provider}
export const listAccounts = async (provider = null) => {
  const params = provider ? { provider } : {};
  const response = await client.get('/cloud/accounts/', { params });
  return ensureArray(response.data);
};

// POST /api/v1/cloud/accounts/
export const addAccount = async (data) => {
  const response = await client.post('/cloud/accounts/', data);
  return response.data;
};

// GET /api/v1/cloud/accounts/{account_id}
export const getAccount = async (accountId) => {
  const response = await client.get(`/cloud/accounts/${accountId}`);
  return response.data;
};

// DELETE /api/v1/cloud/accounts/{account_id}
export const deleteAccount = async (accountId) => {
  await client.delete(`/cloud/accounts/${accountId}`);
};

// GET /api/v1/cloud/{provider}/{account_id}/inventory
export const getInventory = async (
  provider,
  accountId
) => {
  const response = await client.get(`/cloud/${provider.toLowerCase()}/${accountId}/inventory`);
  return ensureArray(response.data);
};

// ============================================================
// Cloud Resource Analysis APIs
// ============================================================

// GET /api/v1/cloud/analyze/aws/{account_id}/ec2/{instance_id}
export const analyzeEC2Instance = async (accountId, instanceId) => {
  const response = await client.get(`/cloud/analyze/aws/${accountId}/ec2/${instanceId}`);
  return response.data;
};

// GET /api/v1/cloud/analyze/aws/{account_id}/lambda/{function_name}
export const analyzeLambdaFunction = async (accountId, functionName) => {
  const response = await client.get(`/cloud/analyze/aws/${accountId}/lambda/${encodeURIComponent(functionName)}`);
  return response.data;
};

// GET /api/v1/cloud/analyze/aws/{account_id}/s3/{bucket_name}
export const analyzeS3Bucket = async (accountId, bucketName) => {
  const response = await client.get(`/cloud/analyze/aws/${accountId}/s3/${bucketName}`);
  return response.data;
};

// GET /api/v1/cloud/analyze/aws/{account_id}/dynamodb/{table_name}
export const analyzeDynamoDBTable = async (accountId, tableName) => {
  const response = await client.get(`/cloud/analyze/aws/${accountId}/dynamodb/${tableName}`);
  return response.data;
};

// Generic analysis dispatcher based on resource type
export const analyzeResource = async (accountId, provider, resourceType, resourceIdentifier) => {
  if (provider.toLowerCase() !== 'aws') {
    throw new Error(`Analysis not yet supported for ${provider}`);
  }

  const type = resourceType.toLowerCase();

  // Flexible matching for resource types (handles "Lambda Function", "EC2 Instance", etc.)
  if (type.includes('ec2') || type.includes('instance')) {
    return analyzeEC2Instance(accountId, resourceIdentifier);
  }

  if (type.includes('lambda') || type.includes('function')) {
    return analyzeLambdaFunction(accountId, resourceIdentifier);
  }

  if (type.includes('s3') || type.includes('bucket')) {
    return analyzeS3Bucket(accountId, resourceIdentifier);
  }

  if (type.includes('dynamodb') || type.includes('table')) {
    return analyzeDynamoDBTable(accountId, resourceIdentifier);
  }

  throw new Error(`Analysis not implemented for resource type: ${resourceType}`);
};
