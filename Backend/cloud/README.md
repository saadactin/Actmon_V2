# ACTMON Cloud Discovery Backend

## 🚀 Overview

Complete cloud resource discovery and deep analysis engine for AWS, Azure, and Oracle Cloud Infrastructure (OCI).

This module provides **real-time discovery** of cloud resources with comprehensive metadata extraction and analysis.

---

## 📋 Features

### AWS Discovery
- ✅ **EC2 Instances** - Full instance details, IPs, security groups, tags
- ✅ **RDS Databases** - All database engines with endpoints and configs
- ✅ **DynamoDB Tables** - Item counts, size, GSI/LSI, encryption status
- ✅ **S3 Buckets** - Versioning, encryption, public access analysis
- ✅ **Lambda Functions** - Runtime, memory, timeout, environment vars
- ✅ **ElastiCache** - Redis/Memcached clusters with endpoints
- ✅ **Load Balancers** - Classic, ALB, NLB with DNS and zones
- ✅ **ECS Clusters** - Task counts, services, container instances
- ✅ **EKS Clusters** - Kubernetes clusters with versions and VPC info

### Azure Discovery
- ✅ **Virtual Machines** - VM size, OS type, power state
- ✅ **Storage Accounts** - SKU, kind, encryption status
- ✅ **SQL Databases** - Database servers and databases with sizes
- ✅ **Network Resources** - VNets, NSGs (extensible)

### Oracle Cloud (OCI) Discovery
- ✅ **Compute Instances** - Shapes, availability domains, IPs
- ✅ **Object Storage Buckets** - Namespaces, public access
- ✅ **Database Systems** - Editions, versions, shapes
- ✅ **All Compartments** - Discovers resources across compartments

---

## 🏗️ Architecture

```
cloud/
├── core/
│   └── base_discovery.py          # Abstract base class for all providers
├── aws/
│   ├── discovery.py                # AWS comprehensive discovery engine
│   ├── services/                   # Service-specific discovery modules
│   └── analyzers/                  # Deep analysis and cost optimization
├── azure/
│   ├── discovery.py                # Azure discovery engine
│   └── services/                   # Azure service modules
├── oracle/
│   ├── discovery.py                # OCI discovery engine
│   └── services/                   # OCI service modules
└── cloud_service.py                # Main orchestration service
```

---

## 🔧 Installation

Dependencies are automatically installed via `requirements.txt`:

```bash
pip install boto3 botocore azure-identity azure-mgmt-compute azure-mgmt-storage azure-mgmt-sql azure-mgmt-resource azure-mgmt-network oci
```

---

## 📖 Usage

### From FastAPI Routes

```python
from cloud.cloud_service import CloudDiscoveryService

# Build account configuration
account_config = {
    "provider": "AWS",
    "account_name": "Production AWS",
    "region": "us-east-1",
    "aws_access_key_id": "AKIA...",
    "aws_secret_access_key": "secret...",
}

# Run discovery
results = CloudDiscoveryService.discover_resources(account_config)

# Access resources
all_resources = results["all"]  # Flat list of all resources
compute = results["compute"]     # Just compute resources
storage = results["storage"]     # Just storage resources
databases = results["databases"] # Just database resources
summary = results["summary"]     # Resource counts
```

### Direct Discovery Engine Usage

```python
from cloud.aws.discovery import AWSDiscovery

aws_discovery = AWSDiscovery(account_config)
aws_discovery.authenticate()

# Discover specific resource types
ec2_instances = aws_discovery.discover_ec2_instances()
dynamodb_tables = aws_discovery.discover_dynamodb_tables()
s3_buckets = aws_discovery.discover_s3_buckets()

# Or discover everything
all_results = aws_discovery.discover_all()
```

---

## 📊 Resource Format

All resources are returned in a standardized format:

```python
{
    "resource_id": "i-1234567890abcdef0",
    "resource_name": "prod-web-server-01",
    "resource_type": "EC2 Instance",
    "region_or_zone": "us-east-1a",
    "status": "running",
    "ip_address": "10.0.1.50",
    "provider": "AWS",
    "account_name": "Production AWS",
    "discovered_at": "2026-06-09T12:00:00",
    "metadata": {
        "instance_type": "t3.medium",
        "vpc_id": "vpc-12345",
        "security_groups": ["sg-12345"],
        "tags": [{"Key": "Environment", "Value": "Production"}],
        # ... provider-specific metadata
    }
}
```

---

## 🔒 Security

- **Credentials are never logged** - All discovery engines handle credentials securely
- **Read-only access** - Discovery engines only need read permissions
- **Timeout protection** - Long-running discoveries have timeouts
- **Error handling** - Failed authentication/discovery doesn't crash the system

---

## 🎯 API Endpoints

### List Accounts
```http
GET /api/v1/cloud/accounts/
GET /api/v1/cloud/accounts/?provider=aws
```

### Create Account
```http
POST /api/v1/cloud/accounts/
Content-Type: application/json

{
  "provider": "AWS",
  "account_name": "My AWS Account",
  "region": "us-east-1",
  "aws_access_key_id": "AKIA...",
  "aws_secret_access_key": "secret..."
}
```

### Get Inventory (Real Discovery)
```http
GET /api/v1/cloud/aws/{account_id}/inventory
GET /api/v1/cloud/azure/{account_id}/inventory
GET /api/v1/cloud/oracle/{account_id}/inventory
```

---

## 🧪 Testing Discovery

```python
# Test AWS Discovery
from cloud.aws.discovery import AWSDiscovery

config = {
    "provider": "AWS",
    "account_name": "Test",
    "region": "us-east-1",
    "aws_access_key_id": "YOUR_KEY",
    "aws_secret_access_key": "YOUR_SECRET",
}

aws = AWSDiscovery(config)
if aws.authenticate():
    results = aws.discover_all()
    print(f"Found {results['summary']['total_resources']} resources")
```

---

## 📈 What Gets Discovered

### AWS Services (15+)
| Service | Resources Discovered |
|---------|---------------------|
| EC2 | Instances, AMIs, Volumes, Snapshots |
| RDS | DB Instances, Clusters, Read Replicas |
| DynamoDB | Tables, GSIs, LSIs, Item Counts, Sizes |
| S3 | Buckets, Versioning, Encryption, Public Access |
| Lambda | Functions, Layers, Runtime, Memory |
| ElastiCache | Redis, Memcached Clusters |
| ELB | Classic LB, Application LB, Network LB |
| ECS | Clusters, Services, Tasks |
| EKS | Kubernetes Clusters, Node Groups |

### Azure Services (5+)
| Service | Resources Discovered |
|---------|---------------------|
| Compute | Virtual Machines, VM Scale Sets |
| Storage | Storage Accounts, Blob Containers |
| SQL | SQL Servers, Databases |
| Networking | VNets, Subnets, NSGs |

### Oracle Cloud Services (5+)
| Service | Resources Discovered |
|---------|---------------------|
| Compute | Instances across compartments |
| Storage | Object Storage Buckets |
| Database | DB Systems, Autonomous Databases |
| Networking | VCNs, Subnets |

---

## 🔄 Auto-Discovery Scheduler

**Coming Soon:** Automated nightly discovery jobs for accounts with `auto_discovery_enabled=true`

---

## 🐛 Troubleshooting

### AWS Authentication Failed
```
❌ AWS Authentication failed: The security token included in the request is invalid
```
**Fix:** Check your access key, secret key, and ensure IAM user has proper permissions

### Azure Authentication Failed
```
❌ Azure Authentication failed: invalid_client
```
**Fix:** Verify tenant ID, client ID, and client secret are correct

### No Resources Found
```
✅ AWS Discovery complete: 0 total resources found
```
**Fix:** Ensure you're using the correct region, or resources exist in your account

---

## 📝 Logs

Discovery progress is logged at INFO level:

```
[AWS] [Production AWS] Discovered 5 EC2 Instances in us-east-1
[AWS] [Production AWS] Discovered 3 DynamoDB Tables in us-east-1
[AWS] [Production AWS] Discovered 10 S3 Buckets in us-east-1
✅ AWS Discovery complete: 45 total resources found
```

---

## 🚀 Performance

- **AWS**: ~2-5 seconds for typical accounts (<50 resources)
- **Azure**: ~3-6 seconds for typical subscriptions
- **Oracle**: ~4-8 seconds across compartments

Large accounts (>500 resources) may take 15-30 seconds.

---

## 🛣️ Roadmap

- [ ] Cost analysis and optimization recommendations
- [ ] Security compliance scanning (CIS benchmarks)
- [ ] Resource tagging analysis
- [ ] Unused resource detection
- [ ] Cross-region discovery
- [ ] Export to CSV/JSON
- [ ] Scheduled discovery jobs
- [ ] Resource change tracking
- [ ] Alerting on new resources

---

## 💡 Example Output

```json
{
  "all": [
    {
      "resource_id": "i-0abc123",
      "resource_name": "prod-api-server",
      "resource_type": "EC2 Instance",
      "status": "running",
      "ip_address": "10.0.1.50",
      "metadata": {
        "instance_type": "t3.large",
        "availability_zone": "us-east-1a"
      }
    }
  ],
  "summary": {
    "total_resources": 45,
    "compute_count": 8,
    "storage_count": 15,
    "database_count": 12,
    "networking_count": 10
  }
}
```

---

## 📞 Support

For issues or questions, check the main ACTMON documentation or logs at `/Backend/logs/`

---

**Built with ❤️ for comprehensive cloud visibility**
