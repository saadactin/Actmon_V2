export interface CloudResource {
  id: string;
  account_id: string;
  provider_resource_id: string;
  resource_type: string;
  resource_name: string;
  region_or_zone: string;
  status: string | null;
  ip_address?: string | null;
  cost_monthly?: number | null;
  discovered_at: string;
  tags?: Record<string, string> | null;
  config?: Record<string, any> | null;
}

export interface CloudResourceDetail extends CloudResource {
  metadata_?: Record<string, any> | null;
  raw_data?: Record<string, any> | null;
}
