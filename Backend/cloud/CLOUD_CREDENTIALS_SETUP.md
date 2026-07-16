# Cloud Credentials Setup — ACTMON Cloud Discovery

This document lists **exactly** what credentials and account-side permissions are
needed for each cloud provider before adding it in ACTMON
(**Cloud → Accounts → Add Account**). Credentials are verified live when you
click *Add Account* — invalid keys are rejected immediately with the provider's
error message and are never stored. Valid credentials are encrypted with
Fernet (key in `Backend/cloud/.env` → `FERNET_KEY`) before being saved.

---

# 1. Oracle Cloud Infrastructure (OCI) — Detailed

## 1.1 What ACTMON scans in OCI

| Category | Resource types discovered |
|---|---|
| Compute | Compute Instances (shape, OCPUs, memory, image, fault domain) |
| Storage | Block Volumes, Object Storage Buckets |
| Database | Autonomous Databases (workload type, OCPUs, storage, auto-scaling) |
| Network | VCNs, Network Security Groups (+rule counts), Load Balancers, Network Load Balancers |
| Serverless / Containers | Functions (per application), OKE Kubernetes clusters (+node pools), API Gateways (+deployments) |
| Identity | IAM Groups (+member counts), IAM Policies (+statements) |
| Cost | Last-30-days actual spend per service via the **Usage API** |
| Security | Open **Cloud Guard** problems (if Cloud Guard is enabled in the tenancy) |

Discovery automatically covers **all subscribed regions** and **all active
compartments** (root + nested). You do not need to list them.

## 1.2 The 6 values ACTMON needs (Add Account form)

| ACTMON form field | What it is | Where to find it | Example |
|---|---|---|---|
| **Tenancy OCID** | Unique ID of your tenancy | Console → Profile icon (top-right) → **Tenancy: \<name\>** → OCID → *Copy* | `ocid1.tenancy.oc1..aaaa…` |
| **User OCID** | ID of the API user | Profile icon → **User settings** (or Identity & Security → Domains → Users → the user) → OCID → *Copy* | `ocid1.user.oc1..aaaa…` |
| **Fingerprint** | Fingerprint of the uploaded API public key | User details → **API keys** — shown next to the key after adding it | `12:34:ab:cd:…` (16 hex pairs) |
| **Private Key Content** | The **entire** RSA private key PEM file text | The `.pem` file you download when generating the API key (downloadable **only once**) | starts `-----BEGIN PRIVATE KEY-----` |
| **Passphrase** (optional) | Only if the key was generated with a passphrase | You chose it at key creation | — |
| **Primary Region** | Your tenancy's **home region** identifier | Console top bar region picker → *Manage Regions* — home region is marked | `ap-mumbai-1` |

> **Important:** enter the **home region** of the tenancy as Primary Region.
> Resource discovery works from any region (ACTMON enumerates all subscribed
> regions itself), but the **Usage API (cost) only answers from the home
> region**, and IAM changes are only writable there.

> **Private key format:** must be an RSA key in PEM format (the one OCI
> generates). OpenSSH-format keys (`-----BEGIN OPENSSH PRIVATE KEY-----`) will
> not work. Paste the whole file including the BEGIN/END lines — ACTMON
> tolerates Windows line endings and single-line pastes and repairs them
> automatically.

## 1.3 What to create in the OCI account — step by step

Do this as a tenancy administrator. Use a **dedicated service user**, not a
personal login, so access can be revoked/rotated independently.

**Step 1 — Create the monitoring user**
1. Console → **Identity & Security → Domains → Default → Users → Create user**
2. Name: `actmon-monitor` (no console password needed — API-only user).

**Step 2 — Create a read-only group and add the user**
1. **Identity & Security → Domains → Default → Groups → Create group**
2. Name: `actmon-readonly-group`
3. Open the group → **Add user to group** → select `actmon-monitor`.

**Step 3 — Generate the API signing key**
1. Open the `actmon-monitor` user → **API keys → Add API key**
2. Choose **Generate API key pair** → **Download private key** (⚠ this is the
   only chance to download it) → **Add**.
3. The console then shows a *Configuration file preview* — it contains the
   `user` OCID, `fingerprint`, `tenancy` OCID and `region`. Copy all of it;
   these are 4 of the 6 values ACTMON needs.
4. A user can hold max 3 API keys — keep one slot free for rotation.

**Step 4 — Create the IAM policy (tenancy root compartment, home region)**

**Identity & Security → Policies → Create Policy** (make sure the compartment
selector at the left shows the **root** compartment), name it
`actmon-readonly-policy`, switch to the manual editor and paste:

```
Allow group actmon-readonly-group to inspect all-resources in tenancy
Allow group actmon-readonly-group to read all-resources in tenancy
Allow group actmon-readonly-group to read usage-reports in tenancy
```

- `inspect/read all-resources` → lets ACTMON list and read every resource type
  it scans (compute, volumes, buckets, DBs, network, LB, functions, OKE,
  API gateways, IAM groups/policies, Cloud Guard problems) in **every**
  compartment and region. It is strictly read-only — no create/update/delete.
- `read usage-reports` → required for the **Usage API**; without it the cost
  dashboard falls back to estimates and logs `NotAuthorizedOrNotFound`.

**If your security team refuses `read all-resources`,** use this granular
equivalent instead (same read-only effect, limited to what ACTMON touches):

```
Allow group actmon-readonly-group to read compartments in tenancy
Allow group actmon-readonly-group to read instance-family in tenancy
Allow group actmon-readonly-group to read volume-family in tenancy
Allow group actmon-readonly-group to read object-family in tenancy
Allow group actmon-readonly-group to read database-family in tenancy
Allow group actmon-readonly-group to read autonomous-database-family in tenancy
Allow group actmon-readonly-group to read virtual-network-family in tenancy
Allow group actmon-readonly-group to read load-balancers in tenancy
Allow group actmon-readonly-group to read network-load-balancers in tenancy
Allow group actmon-readonly-group to read functions-family in tenancy
Allow group actmon-readonly-group to read cluster-family in tenancy
Allow group actmon-readonly-group to read api-gateway-family in tenancy
Allow group actmon-readonly-group to inspect groups in tenancy
Allow group actmon-readonly-group to inspect users in tenancy
Allow group actmon-readonly-group to inspect policies in tenancy
Allow group actmon-readonly-group to read cloud-guard-family in tenancy
Allow group actmon-readonly-group to read usage-reports in tenancy
```

**Step 5 (optional, for the security page) — Enable Cloud Guard**
- **Identity & Security → Cloud Guard → Enable** (choose reporting region +
  monitored regions). If disabled, ACTMON simply shows no OCI security
  findings — nothing breaks.

## 1.4 Checklist to hand to the OCI admin

- [ ] User `actmon-monitor` created (API-only)
- [ ] Group `actmon-readonly-group` created, user added
- [ ] API key pair generated, private `.pem` saved securely, fingerprint noted
- [ ] Policy `actmon-readonly-policy` created **in the root compartment** with the 3 statements above
- [ ] Tenancy OCID, User OCID, fingerprint, private key, home region collected
- [ ] (Optional) Cloud Guard enabled
- [ ] ACTMON server allows outbound HTTPS (443) to `*.oraclecloud.com`

## 1.5 How ACTMON validates and what errors mean

| Symptom when adding / scanning | Cause |
|---|---|
| `OCI authentication failed: … NotAuthenticated` (401) | Wrong user/tenancy OCID, wrong fingerprint, or key doesn't match fingerprint |
| `could not deserialize key data` | Pasted key isn't the PEM RSA private key (or passphrase missing/wrong) |
| Scan finishes but **0 resources** + `Missing required IAM permissions` | Policy missing / created in a sub-compartment instead of root |
| Cost page shows `estimated` instead of `billing_api` | `read usage-reports` missing, or Primary Region ≠ home region |
| No security findings | Cloud Guard not enabled (optional) |

---

# 2. AWS — Quick Reference

**Form fields:** Access Key ID + Secret Access Key.

**Create in AWS:**
1. IAM → Users → Create user `actmon-monitor` (no console access).
2. Attach managed policy **`ReadOnlyAccess`** (covers EC2, RDS, S3, Lambda,
   EKS, DynamoDB, ELB, VPC, security groups, IAM roles, API Gateway, Bedrock —
   everything the scanner reads, including `ce:GetCostAndUsage`).
   - Minimal alternative: `ViewOnlyAccess` **plus** an inline policy allowing
     `ce:GetCostAndUsage`.
3. Security credentials → **Create access key** → *Third-party service* →
   copy Key ID + Secret.
4. **Cost Explorer must be enabled once** (Billing → Cost Explorer → Enable;
   first enablement takes up to 24 h to populate). Without it the cost
   dashboard falls back to estimates.

Discovery covers **all enabled regions** automatically; the region field is
fixed to `us-east-1` in the form and only used as the default API endpoint.

*Corporate proxy note:* SSL verification is **on** by default. If your proxy
does TLS interception, set `AWS_CA_BUNDLE=<path to proxy CA .pem>` (preferred)
or `CLOUD_SSL_VERIFY=false` (last resort) in `Backend/cloud/.env`.

---

# 3. Microsoft Azure — Quick Reference

**Form fields:** Tenant ID, Client ID, Client Secret, Subscription ID.

**Create in Azure:**
1. **Entra ID → App registrations → New registration** → name `actmon-monitor`.
   - *Application (client) ID* → **Client ID**; *Directory (tenant) ID* → **Tenant ID**.
2. App → **Certificates & secrets → New client secret** → copy the **Value**
   immediately (not the Secret ID) → **Client Secret**. Note the expiry date —
   secrets expire (max 24 months) and must be rotated.
3. **Subscriptions → your subscription** → copy **Subscription ID**.
4. Same subscription → **Access control (IAM) → Add role assignment**:
   - **`Reader`** → for resource discovery (VMs, storage, SQL, AKS, everything).
   - **`Cost Management Reader`** → for actual spend via the Cost Management
     API. (Note: sponsored/credit subscriptions like Azure Sponsorship often
     return no cost data by design — ACTMON then falls back to estimates.)

---

# 4. After adding an account

1. Click **Add Account** — ACTMON authenticates live against the provider;
   a wrong credential is rejected on the spot with the provider's own message.
2. With *Auto-Discovery* enabled, a background scan starts immediately;
   otherwise trigger it from the account list. Progress is tracked as a
   discovery job.
3. Resources appear under **Cloud → Resources**, cost under **Cloud → Cost**
   (`cost_source: billing_api` = real spend, `estimated` = fallback),
   security findings under **Cloud → Security**.
