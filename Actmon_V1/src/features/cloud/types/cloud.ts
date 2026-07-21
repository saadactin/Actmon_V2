export interface CloudAccount {
  id: string;
  provider: 'AWS' | 'Azure' | 'OCI';
  account_name: string;
  environment: string;
  tenant_or_region: string;
  auto_discovery: boolean;
  last_discovery?: string;
  created_at: string;
}

export interface CloudAccountCreatePayload {
  provider: 'AWS' | 'Azure' | 'OCI';
  account_name: string;
  environment?: string;
  tenant_or_region: string;
  auth_mode?: string;
  auto_discovery?: boolean;
  
  // AWS specific
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  
  // Azure specific
  tenant_id?: string;
  client_id?: string;
  client_secret?: string;
  subscription_id?: string;
  
  // OCI specific
  oci_tenancy_ocid?: string;
  oci_user_ocid?: string;
  oci_fingerprint?: string;
  oci_private_key_content?: string;
  oci_passphrase?: string;
}

export interface DiscoveryJob {
  id: string;
  account_id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  resources_found: number;
  error_message?: string;
  started_at: string;
  completed_at?: string;
}

export interface CostEntry {
  resource_type: string;
  resource_name: string;
  region: string;
  monthly_cost: number;
  currency: string;
}

export interface CostSummary {
  account_id: string;
  provider: string;
  total_monthly_cost: number;
  currency: string;
  breakdown: CostEntry[];
}
