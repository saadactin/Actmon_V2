"""
Quick AWS credentials validation script.
Tests if the provided AWS credentials can authenticate and list basic resources.
"""
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

# Test credentials - REPLACE WITH YOUR OWN
AWS_ACCESS_KEY = "YOUR_AWS_ACCESS_KEY_HERE"
AWS_SECRET_KEY = "YOUR_AWS_SECRET_KEY_HERE"
AWS_REGION = "ap-south-1"

print("=" * 80)
print("AWS Credentials Quick Test")
print("=" * 80)
print(f"Region: {AWS_REGION}")
print(f"Access Key: {AWS_ACCESS_KEY[:10]}...{AWS_ACCESS_KEY[-4:]}")
print()

# Create session
try:
    session = boto3.Session(
        aws_access_key_id=AWS_ACCESS_KEY,
        aws_secret_access_key=AWS_SECRET_KEY,
        region_name=AWS_REGION
    )
    print("✓ Session created successfully")
except Exception as e:
    print(f"✗ Failed to create session: {e}")
    exit(1)

# Test 1: Get caller identity (verify credentials work)
print("\n" + "-" * 80)
print("Test 1: Verify credentials (sts:GetCallerIdentity)")
print("-" * 80)
try:
    sts = session.client('sts')
    identity = sts.get_caller_identity()
    print(f"✓ Credentials are valid!")
    print(f"  Account: {identity['Account']}")
    print(f"  User ARN: {identity['Arn']}")
    print(f"  User ID: {identity['UserId']}")
except NoCredentialsError:
    print("✗ No credentials found")
    exit(1)
except ClientError as e:
    print(f"✗ Authentication failed: {e}")
    exit(1)

# Test 2: List regions
print("\n" + "-" * 80)
print("Test 2: List available regions")
print("-" * 80)
try:
    ec2 = session.client('ec2')
    response = ec2.describe_regions(
        Filters=[{"Name": "opt-in-status", "Values": ["opt-in-not-required", "opted-in"]}]
    )
    regions = [r['RegionName'] for r in response['Regions']]
    print(f"✓ Found {len(regions)} regions")
    print(f"  Regions: {', '.join(regions[:5])}{'...' if len(regions) > 5 else ''}")
except ClientError as e:
    print(f"⚠ Warning: Could not list regions - {e.response['Error']['Code']}")
    print(f"  Message: {e.response['Error']['Message']}")

# Test 3: List EC2 instances in the specified region
print("\n" + "-" * 80)
print(f"Test 3: List EC2 instances in {AWS_REGION}")
print("-" * 80)
try:
    ec2 = session.client('ec2', region_name=AWS_REGION)
    response = ec2.describe_instances()

    instance_count = 0
    for reservation in response.get('Reservations', []):
        for instance in reservation.get('Instances', []):
            instance_count += 1
            instance_id = instance['InstanceId']
            state = instance['State']['Name']
            instance_type = instance.get('InstanceType', 'N/A')
            name = next((t['Value'] for t in instance.get('Tags', []) if t['Key'] == 'Name'), 'N/A')

            print(f"  - {instance_id} ({name})")
            print(f"    State: {state}, Type: {instance_type}")

    if instance_count == 0:
        print("  No EC2 instances found in this region")
    else:
        print(f"✓ Found {instance_count} EC2 instance(s)")

except ClientError as e:
    print(f"⚠ Warning: Could not list EC2 instances - {e.response['Error']['Code']}")
    print(f"  Message: {e.response['Error']['Message']}")

# Test 4: List S3 buckets (global)
print("\n" + "-" * 80)
print("Test 4: List S3 buckets (global)")
print("-" * 80)
try:
    s3 = session.client('s3')
    response = s3.list_buckets()
    buckets = response.get('Buckets', [])

    if len(buckets) == 0:
        print("  No S3 buckets found")
    else:
        print(f"✓ Found {len(buckets)} S3 bucket(s)")
        for bucket in buckets[:5]:
            print(f"  - {bucket['Name']} (created: {bucket['CreationDate']})")
        if len(buckets) > 5:
            print(f"  ... and {len(buckets) - 5} more")

except ClientError as e:
    print(f"⚠ Warning: Could not list S3 buckets - {e.response['Error']['Code']}")
    print(f"  Message: {e.response['Error']['Message']}")

# Test 5: List RDS instances
print("\n" + "-" * 80)
print(f"Test 5: List RDS instances in {AWS_REGION}")
print("-" * 80)
try:
    rds = session.client('rds', region_name=AWS_REGION)
    response = rds.describe_db_instances()
    instances = response.get('DBInstances', [])

    if len(instances) == 0:
        print("  No RDS instances found in this region")
    else:
        print(f"✓ Found {len(instances)} RDS instance(s)")
        for db in instances[:5]:
            print(f"  - {db['DBInstanceIdentifier']}")
            print(f"    Engine: {db['Engine']}, Status: {db['DBInstanceStatus']}")

except ClientError as e:
    print(f"⚠ Warning: Could not list RDS instances - {e.response['Error']['Code']}")
    print(f"  Message: {e.response['Error']['Message']}")

# Test 6: List Lambda functions
print("\n" + "-" * 80)
print(f"Test 6: List Lambda functions in {AWS_REGION}")
print("-" * 80)
try:
    lambda_client = session.client('lambda', region_name=AWS_REGION)
    response = lambda_client.list_functions()
    functions = response.get('Functions', [])

    if len(functions) == 0:
        print("  No Lambda functions found in this region")
    else:
        print(f"✓ Found {len(functions)} Lambda function(s)")
        for func in functions[:5]:
            print(f"  - {func['FunctionName']}")
            print(f"    Runtime: {func['Runtime']}, Last Modified: {func['LastModified']}")

except ClientError as e:
    print(f"⚠ Warning: Could not list Lambda functions - {e.response['Error']['Code']}")
    print(f"  Message: {e.response['Error']['Message']}")

# Summary
print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
print("✓ AWS credentials are valid and working")
print("\nYou can now proceed to:")
print("  1. Start the cloud discovery service: cd Backend/cloud && run_service.bat")
print("  2. Run the full test: python test_discovery.py")
print("  3. Or use the API directly via Swagger UI at: http://127.0.0.1:8002/api/v1/cloud/docs")
print()
