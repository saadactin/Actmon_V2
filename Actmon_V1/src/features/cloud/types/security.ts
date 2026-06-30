export interface SecurityFinding {
  resource_id: string;
  resource_name: string;
  resource_type: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  title: string;
  description: string;
  recommendation: string;
  category: string;
}

export interface SecurityPosture {
  account_id: string;
  score: number;
  grade: string;
  total_resources_scanned: number;
  total_findings: number;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  findings: SecurityFinding[];
}
