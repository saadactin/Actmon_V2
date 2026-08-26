"""OCI resource scanner — full coverage: Compute, Block Volumes, Object Storage, DBs,
VCN, NSG, Load Balancers, Functions, OKE (Kubernetes), API Gateway, IAM Groups,
across ALL subscribed OCI regions."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

import oci

from app.providers.oci.oci_auth import OCIAuth
from app.providers.scan_pool import scan_pool

logger = logging.getLogger("cloud_svc.oci.scanner")

_TIMEOUT = oci.retry.DEFAULT_RETRY_STRATEGY


def _oci_port_range(rule) -> Dict[str, Any] | None:
    """Normalise OCI's per-protocol port-range shape to {min, max}.

    A SecurityRule keeps its port range under `tcp_options` or `udp_options`
    (mutually exclusive with each other and with `icmp_options`), each with a
    `destination_port_range` of {min, max}. None of the three means "all ports
    for this protocol" — returning None here preserves that distinction rather
    than defaulting to a specific range that would misreport an all-ports rule
    as narrower than it is.
    """
    opts = rule.tcp_options or rule.udp_options
    if opts and opts.destination_port_range:
        r = opts.destination_port_range
        return {"min": r.min, "max": r.max}
    return None


class OCIScanner:
    def __init__(self, auth: OCIAuth) -> None:
        self.auth = auth
        self.config = auth.get_config()
        # compartment OCID -> readable name, populated during compartment discovery
        self._compartment_names: Dict[str, str] = {}
        # region -> [availability domain names], lazily populated. Boot volumes
        # and file systems are listed per-AD (unlike regular block volumes),
        # and ADs are tenancy-wide, so this is fetched once per region rather
        # than once per (region, compartment) scanner call.
        self._ads_cache: Dict[str, List[str]] = {}
        # Scopes (region/compartment/service) whose enumeration failed this run.
        # Non-empty means the sweep is INCOMPLETE and its result must never be
        # treated as the full inventory — pruning against a partial sweep would
        # delete live resources that simply couldn't be listed.
        self.scan_failures: List[str] = []

    # ── Helpers ───────────────────────────────────────────────────────────────

    # (connect, read) seconds. Without this an unreachable service/region hangs
    # the socket indefinitely and blocks the whole parallel scan from finishing.
    _CLIENT_TIMEOUT = (10, 60)

    # Max scanner calls in flight at once across the whole region × compartment
    # fan-out. Keeps concurrent TLS/DNS well below the level that makes the
    # local network stack start refusing connections.
    _MAX_CONCURRENT_SCANS = 8

    @staticmethod
    def _retry_strategy():
        """Bounded retry so transient SSL/connection resets get one quick retry
        without the default strategy's long exponential backoff (which was making
        scans take 20+ minutes). Falls back to no-retry if the builder API differs."""
        try:
            return (
                oci.retry.RetryStrategyBuilder()
                .add_max_attempts(max_attempts=2)
                .add_total_elapsed_time(total_elapsed_time_seconds=20)
                .get_retry_strategy()
            )
        except Exception:
            return oci.retry.NoneRetryStrategy()

    def _client_for_region(self, client_class, region: str):
        """Create an OCI client configured for a specific region."""
        cfg = dict(self.config)
        cfg["region"] = region
        return client_class(cfg, timeout=self._CLIENT_TIMEOUT,
                            retry_strategy=self._retry_strategy())

    def _identity_client(self):
        """Identity client on the home region, with a timeout + bounded retry."""
        return oci.identity.IdentityClient(self.config, timeout=self._CLIENT_TIMEOUT,
                                           retry_strategy=self._retry_strategy())

    # ── Region Discovery ──────────────────────────────────────────────────────

    async def _get_subscribed_regions(self) -> List[str]:
        """Return all region names the tenancy is subscribed to."""
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = self._identity_client()
            subscriptions = identity.list_region_subscriptions(
                self.auth.tenancy_ocid
            ).data
            return [s.region_name for s in subscriptions if s.status == "READY"]

        try:
            regions = await loop.run_in_executor(scan_pool(), _fetch)
            logger.info("OCI subscribed regions: %s", regions)
            return regions or [self.auth.region]
        except Exception as exc:
            logger.warning("OCI region discovery failed, using home region: %s", exc)
            return [self.auth.region]

    # ── Compartment Discovery ─────────────────────────────────────────────────

    async def _get_compartments(self) -> List[str]:
        """Return tenancy root + all active sub-compartments, and cache their
        readable names in self._compartment_names for topology labeling."""
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = self._identity_client()
            compartments = oci.pagination.list_call_get_all_results(
                identity.list_compartments,
                self.auth.tenancy_ocid,
                compartment_id_in_subtree=True,
            ).data
            names: Dict[str, str] = {}
            try:
                names[self.auth.tenancy_ocid] = (
                    identity.get_tenancy(self.auth.tenancy_ocid).data.name or "root"
                )
            except Exception:
                names[self.auth.tenancy_ocid] = "root"
            for c in compartments:
                if c.lifecycle_state == "ACTIVE":
                    names[c.id] = c.name
            ids = [self.auth.tenancy_ocid] + [
                c.id for c in compartments if c.lifecycle_state == "ACTIVE"
            ]
            return ids, names

        ids, names = await loop.run_in_executor(scan_pool(), _fetch)
        self._compartment_names = names
        return ids

    def _ads_for_region(self, region: str) -> List[str]:
        """Availability domain names for a region (tenancy-wide, so cached per
        region rather than refetched for every compartment). Called from
        inside a scanner's own executor thread, not the event loop."""
        cached = self._ads_cache.get(region)
        if cached is not None:
            return cached
        try:
            identity = self._client_for_region(oci.identity.IdentityClient, region)
            ads = [
                ad.name for ad in oci.pagination.list_call_get_all_results(
                    identity.list_availability_domains, self.auth.tenancy_ocid
                ).data
            ]
        except Exception as exc:
            logger.warning("OCI AD discovery failed in %s: %s", region, exc)
            ads = []
        self._ads_cache[region] = ads
        return ads

    # ── Compute Instances ─────────────────────────────────────────────────────

    async def _scan_compute(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            compute = self._client_for_region(oci.core.ComputeClient, region)
            try:
                instances = oci.pagination.list_call_get_all_results(
                    compute.list_instances, compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"Compute [{region}]: {str(exc)[:160]}")
                return []
            active = [i for i in instances if i.lifecycle_state not in ("TERMINATED",)]
            if not active:
                return []

            # ── Attached-storage sizing ──────────────────────────────────────
            # A stopped instance still pays for its boot + block volumes, so we
            # need their real sizes to quantify the waste. Fetch them with a few
            # compartment/AD-wide list calls (not one call per instance) and map
            # them back to each instance. Any failure just leaves sizes as None,
            # and the cost layer then reports NA rather than guessing.
            block = self._client_for_region(oci.core.BlockstorageClient, region)

            vol_size: Dict[str, float] = {}          # block volume id -> GB
            try:
                for v in oci.pagination.list_call_get_all_results(
                    block.list_volumes, compartment_id=compartment_id
                ).data:
                    vol_size[v.id] = v.size_in_gbs
            except Exception:
                pass

            inst_block: Dict[str, List[str]] = {}    # instance id -> [block volume id]
            try:
                for a in oci.pagination.list_call_get_all_results(
                    compute.list_volume_attachments, compartment_id
                ).data:
                    if a.lifecycle_state == "DETACHED":
                        continue
                    inst_block.setdefault(a.instance_id, []).append(a.volume_id)
            except Exception:
                pass

            boot_size: Dict[str, float] = {}         # boot volume id -> GB
            inst_boot: Dict[str, str] = {}           # instance id -> boot volume id
            for ad in {i.availability_domain for i in active if i.availability_domain}:
                try:
                    for a in oci.pagination.list_call_get_all_results(
                        compute.list_boot_volume_attachments, ad, compartment_id
                    ).data:
                        if a.lifecycle_state == "DETACHED":
                            continue
                        inst_boot[a.instance_id] = a.boot_volume_id
                except Exception:
                    pass
                try:
                    for bv in oci.pagination.list_call_get_all_results(
                        block.list_boot_volumes,
                        availability_domain=ad,
                        compartment_id=compartment_id,
                    ).data:
                        boot_size[bv.id] = bv.size_in_gbs
                except Exception:
                    pass

            # ── Network placement ────────────────────────────────────────────
            # An instance's subnet and IPs live on its VNIC, not on the instance,
            # so without this an instance has no link to the network it sits in —
            # and ip_address stayed None for every instance in the inventory.
            # One list call per compartment, then one get_vnic per attachment.
            inst_vnic: Dict[str, Dict[str, Any]] = {}
            try:
                net = self._client_for_region(oci.core.VirtualNetworkClient, region)
                for va in oci.pagination.list_call_get_all_results(
                    compute.list_vnic_attachments, compartment_id
                ).data:
                    if va.lifecycle_state != "ATTACHED" or not va.vnic_id:
                        continue
                    if va.instance_id in inst_vnic:
                        continue  # primary VNIC is enough for placement
                    try:
                        vnic = net.get_vnic(va.vnic_id).data
                    except Exception:
                        continue
                    inst_vnic[va.instance_id] = {
                        "subnet_id": vnic.subnet_id,
                        "private_ip": vnic.private_ip,
                        "public_ip": vnic.public_ip,
                        "nsg_ids": list(vnic.nsg_ids or []),
                        "hostname": vnic.hostname_label,
                    }
            except Exception as exc:
                # Placement is an enrichment: losing it must not lose the instance.
                logger.debug("VNIC lookup failed in %s/%s: %s", region, compartment_id, exc)

            results = []
            for inst in active:
                vnic_info = inst_vnic.get(inst.id, {})
                boot_gb = boot_size.get(inst_boot.get(inst.id))
                block_gbs = [
                    vol_size[vid] for vid in inst_block.get(inst.id, []) if vid in vol_size
                ]
                block_gb = round(sum(block_gbs), 2) if block_gbs else None
                attached = [g for g in (boot_gb, block_gb) if g is not None]
                attached_gb = round(sum(attached), 2) if attached else None
                results.append(
                    {
                        "provider_resource_id": inst.id,
                        "resource_type": "ComputeInstance",
                        "resource_name": inst.display_name,
                        # The region, not the availability domain. Storing the AD
                        # here ("hpAD:AP-MUMBAI-1-AD-1") made the dashboard's
                        # region breakdown list ADs as if they were regions; the
                        # AD is kept below, where it belongs.
                        "region_or_zone": region,
                        "status": inst.lifecycle_state,
                        "ip_address": vnic_info.get("public_ip") or vnic_info.get("private_ip"),
                        "config": {
                            "availability_domain": inst.availability_domain,
                            "fault_domain_full": inst.fault_domain,
                            "shape": inst.shape,
                            "ocpus": inst.shape_config.ocpus if inst.shape_config else None,
                            "memory_gb": inst.shape_config.memory_in_gbs if inst.shape_config else None,
                            "image_id": inst.image_id,
                            "fault_domain": inst.fault_domain,
                            # Network placement, from the instance's primary VNIC.
                            "subnet_id": vnic_info.get("subnet_id"),
                            "nsg_ids": vnic_info.get("nsg_ids") or [],
                            "private_ip": vnic_info.get("private_ip"),
                            "public_ip": vnic_info.get("public_ip"),
                            # Real provisioned storage (GB) that a stopped instance
                            # keeps paying for; None when the volume APIs were unreadable.
                            "boot_volume_gb": boot_gb,
                            "block_volume_gb": block_gb,
                            "block_volume_count": len(inst_block.get(inst.id, [])) or None,
                            "attached_storage_gb": attached_gb,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(inst.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": {**inst.defined_tags.get("Oracle-Tags", {}), **inst.freeform_tags},
                        "raw_data": {
                            "id": inst.id,
                            "display_name": inst.display_name,
                            "lifecycle_state": inst.lifecycle_state,
                        },
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Block Volumes ─────────────────────────────────────────────────────────

    async def _scan_block_volumes(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            block = self._client_for_region(oci.core.BlockstorageClient, region)
            compute = self._client_for_region(oci.core.ComputeClient, region)
            try:
                volumes = oci.pagination.list_call_get_all_results(
                    block.list_volumes, compartment_id=compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"BlockVolume [{region}]: {str(exc)[:160]}")
                return []

            # Map each volume to the instance holding it (if any), so the UI can
            # filter Attached/Unattached and show which server is still paying
            # for a volume attached to a stopped instance.
            vol_instance: Dict[str, str] = {}
            try:
                for a in oci.pagination.list_call_get_all_results(
                    compute.list_volume_attachments, compartment_id
                ).data:
                    if a.lifecycle_state == "DETACHED":
                        continue
                    vol_instance[a.volume_id] = a.instance_id
            except Exception:
                pass

            instance_info: Dict[str, Dict[str, str]] = {}
            if vol_instance:
                try:
                    for inst in oci.pagination.list_call_get_all_results(
                        compute.list_instances, compartment_id
                    ).data:
                        instance_info[inst.id] = {
                            "name": inst.display_name,
                            "status": inst.lifecycle_state,
                        }
                except Exception:
                    pass

            results = []
            for vol in volumes:
                if vol.lifecycle_state in ("TERMINATED",):
                    continue
                inst_id = vol_instance.get(vol.id)
                inst = instance_info.get(inst_id) if inst_id else None
                results.append(
                    {
                        "provider_resource_id": vol.id,
                        "resource_type": "BlockVolume",
                        "resource_name": vol.display_name,
                        # Region, not the availability domain (kept in config).
                        "region_or_zone": region,
                        "status": vol.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "availability_domain": vol.availability_domain,
                            "size_gb": vol.size_in_gbs,
                            "vpus_per_gb": vol.vpus_per_gb,
                            "is_auto_tune_enabled": vol.is_auto_tune_enabled,
                            "attachment_status": "Attached" if inst_id else "Unattached",
                            "attached_to_id": inst_id,
                            "attached_to_name": inst["name"] if inst else None,
                            "attached_to_status": inst["status"] if inst else None,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vol.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vol.freeform_tags,
                        "raw_data": {"id": vol.id, "display_name": vol.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Boot Volumes ─────────────────────────────────────────────────────────
    # Previously only visible as config on their attached ComputeInstance
    # (boot_volume_gb), so a boot volume billed after its instance was deleted
    # — or one whose instance a scan pass couldn't reach — had no inventory
    # row of its own and showed as "not in inventory" on the cost report.

    async def _scan_boot_volumes(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            block = self._client_for_region(oci.core.BlockstorageClient, region)
            compute = self._client_for_region(oci.core.ComputeClient, region)
            ads = self._ads_for_region(region)
            if not ads:
                self.scan_failures.append(f"BootVolume [{region}]: no availability domains resolved")
                return []

            volumes = []
            for ad in ads:
                try:
                    volumes.extend(oci.pagination.list_call_get_all_results(
                        block.list_boot_volumes, availability_domain=ad, compartment_id=compartment_id,
                    ).data)
                except Exception as exc:
                    self.scan_failures.append(f"BootVolume [{region}/{ad}]: {str(exc)[:160]}")

            # Same attach-mapping approach as _scan_block_volumes, via boot
            # volume attachments (a separate API from regular volume attachments).
            vol_instance: Dict[str, str] = {}
            for ad in ads:
                try:
                    for a in oci.pagination.list_call_get_all_results(
                        compute.list_boot_volume_attachments, ad, compartment_id
                    ).data:
                        if a.lifecycle_state == "DETACHED":
                            continue
                        vol_instance[a.boot_volume_id] = a.instance_id
                except Exception:
                    pass

            instance_info: Dict[str, Dict[str, str]] = {}
            if vol_instance:
                try:
                    for inst in oci.pagination.list_call_get_all_results(
                        compute.list_instances, compartment_id
                    ).data:
                        instance_info[inst.id] = {"name": inst.display_name, "status": inst.lifecycle_state}
                except Exception:
                    pass

            results = []
            for vol in volumes:
                if vol.lifecycle_state in ("TERMINATED", "TERMINATING"):
                    continue
                inst_id = vol_instance.get(vol.id)
                inst = instance_info.get(inst_id) if inst_id else None
                results.append(
                    {
                        "provider_resource_id": vol.id,
                        "resource_type": "BootVolume",
                        "resource_name": vol.display_name,
                        "region_or_zone": region,
                        "status": vol.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "availability_domain": vol.availability_domain,
                            "size_gb": vol.size_in_gbs,
                            "vpus_per_gb": vol.vpus_per_gb,
                            "image_id": vol.image_id,
                            "attachment_status": "Attached" if inst_id else "Unattached",
                            "attached_to_id": inst_id,
                            "attached_to_name": inst["name"] if inst else None,
                            "attached_to_status": inst["status"] if inst else None,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vol.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vol.freeform_tags or {},
                        "raw_data": {"id": vol.id, "display_name": vol.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Object Storage Buckets ────────────────────────────────────────────────

    async def _scan_object_storage(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ns_client = self._client_for_region(oci.object_storage.ObjectStorageClient, region)
            try:
                namespace = ns_client.get_namespace(compartment_id=compartment_id).data
                buckets = oci.pagination.list_call_get_all_results(
                    ns_client.list_buckets, namespace, compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"ObjectStorage [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for b in buckets:
                # list_buckets returns BucketSummary, which has no storage_tier /
                # public_access_type / versioning — those live on the full Bucket,
                # so fetch it. All three stay None if get_bucket is unavailable.
                storage_tier = None
                public_access_type = None
                bucket_versioning = None
                try:
                    full = ns_client.get_bucket(namespace, b.name).data
                    storage_tier = getattr(full, "storage_tier", None)
                    public_access_type = getattr(full, "public_access_type", None)
                    bucket_versioning = getattr(full, "versioning", None)
                except Exception:
                    pass
                results.append(
                    {
                        "provider_resource_id": f"{namespace}/{b.name}",
                        "resource_type": "ObjectStorageBucket",
                        "resource_name": b.name,
                        "region_or_zone": region,
                        # OCI buckets have no lifecycle state in the API
                        "status": None,
                        "ip_address": None,
                        "config": {"namespace": namespace, "storage_tier": storage_tier,
                                   "public_access_type": public_access_type,
                                   "versioning": bucket_versioning},
                        "metadata": {"time_created": str(b.time_created), "region": region,
                                     "compartment_id": compartment_id},
                        "cost_monthly": None,
                        "tags": b.freeform_tags or {},
                        "raw_data": {"name": b.name, "namespace": namespace},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── File Storage File Systems ────────────────────────────────────────────

    async def _scan_file_systems(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            fs_client = self._client_for_region(oci.file_storage.FileStorageClient, region)
            ads = self._ads_for_region(region)
            if not ads:
                self.scan_failures.append(f"FileSystem [{region}]: no availability domains resolved")
                return []

            filesystems = []
            for ad in ads:
                try:
                    filesystems.extend(oci.pagination.list_call_get_all_results(
                        fs_client.list_file_systems, compartment_id=compartment_id, availability_domain=ad,
                    ).data)
                except Exception as exc:
                    self.scan_failures.append(f"FileSystem [{region}/{ad}]: {str(exc)[:160]}")

            results = []
            for fs in filesystems:
                if fs.lifecycle_state in ("DELETED", "DELETING"):
                    continue
                results.append(
                    {
                        "provider_resource_id": fs.id,
                        "resource_type": "FileSystem",
                        "resource_name": fs.display_name,
                        "region_or_zone": region,
                        "status": fs.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "availability_domain": fs.availability_domain,
                            # Real metered size (bytes, includes snapshots) — the
                            # only size OCI reports for a file system; there is
                            # no separately-provisioned capacity to show instead.
                            "metered_bytes": fs.metered_bytes,
                            "kms_key_id": fs.kms_key_id,
                            "is_clone_parent": fs.is_clone_parent,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(fs.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": fs.freeform_tags or {},
                        "raw_data": {"id": fs.id, "display_name": fs.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Analytics Cloud Instances ─────────────────────────────────────────────

    async def _scan_analytics_instances(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            an_client = self._client_for_region(oci.analytics.AnalyticsClient, region)
            try:
                instances = oci.pagination.list_call_get_all_results(
                    an_client.list_analytics_instances, compartment_id=compartment_id,
                ).data
            except Exception as exc:
                self.scan_failures.append(f"AnalyticsInstance [{region}]: {str(exc)[:160]}")
                return []

            results = []
            for inst in instances:
                if inst.lifecycle_state in ("DELETED",):
                    continue
                cap = inst.capacity
                results.append(
                    {
                        "provider_resource_id": inst.id,
                        "resource_type": "AnalyticsInstance",
                        # This model's own field is literally "name", not
                        # "display_name" — verified against the installed SDK,
                        # not assumed from the pattern every other model uses.
                        "resource_name": inst.name,
                        "region_or_zone": region,
                        "status": inst.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "feature_set": inst.feature_set,
                            "license_type": inst.license_type,
                            "capacity_type": cap.capacity_type if cap else None,
                            "capacity_value": cap.capacity_value if cap else None,
                            "service_url": inst.service_url,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(inst.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": inst.freeform_tags or {},
                        "raw_data": {"id": inst.id, "name": inst.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Web Application Firewalls ────────────────────────────────────────────

    async def _scan_waf(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            waf_client = self._client_for_region(oci.waf.WafClient, region)
            try:
                # list_web_app_firewalls returns a WebAppFirewallCollection —
                # the summaries live at .items, not the response data itself.
                firewalls = oci.pagination.list_call_get_all_results(
                    waf_client.list_web_app_firewalls, compartment_id=compartment_id,
                ).data
            except Exception as exc:
                self.scan_failures.append(f"WAF [{region}]: {str(exc)[:160]}")
                return []

            results = []
            for fw in firewalls:
                if fw.lifecycle_state in ("DELETED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": fw.id,
                        "resource_type": "WebAppFirewall",
                        "resource_name": fw.display_name,
                        "region_or_zone": region,
                        "status": fw.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "backend_type": fw.backend_type,
                            "web_app_firewall_policy_id": fw.web_app_firewall_policy_id,
                            # Only present on the LOAD_BALANCER backend subtype,
                            # not the WebAppFirewallSummary base — absent (None)
                            # for any other backend_type.
                            "load_balancer_id": getattr(fw, "load_balancer_id", None),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(fw.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": fw.freeform_tags or {},
                        "raw_data": {"id": fw.id, "display_name": fw.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── FastConnect (Virtual Circuits + DRG Attachments) ─────────────────────

    async def _scan_virtual_circuits(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                circuits = oci.pagination.list_call_get_all_results(
                    net.list_virtual_circuits, compartment_id=compartment_id,
                ).data
            except Exception as exc:
                self.scan_failures.append(f"VirtualCircuit [{region}]: {str(exc)[:160]}")
                return []

            results = []
            for vc in circuits:
                if vc.lifecycle_state in ("TERMINATED", "TERMINATING"):
                    continue
                results.append(
                    {
                        "provider_resource_id": vc.id,
                        "resource_type": "VirtualCircuit",
                        "resource_name": vc.display_name,
                        "region_or_zone": region,
                        "status": vc.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "bandwidth_shape_name": vc.bandwidth_shape_name,
                            "type": vc.type,
                            "provider_name": vc.provider_name,
                            "provider_state": vc.provider_state,
                            "bgp_session_state": vc.bgp_session_state,
                            "gateway_id": vc.gateway_id,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vc.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vc.freeform_tags or {},
                        "raw_data": {"id": vc.id, "display_name": vc.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    async def _scan_drg_attachments(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                attachments = oci.pagination.list_call_get_all_results(
                    net.list_drg_attachments, compartment_id=compartment_id,
                ).data
            except Exception as exc:
                self.scan_failures.append(f"DrgAttachment [{region}]: {str(exc)[:160]}")
                return []

            results = []
            for da in attachments:
                if da.lifecycle_state in ("DETACHED", "DETACHING"):
                    continue
                details = da.network_details
                results.append(
                    {
                        "provider_resource_id": da.id,
                        "resource_type": "DrgAttachment",
                        "resource_name": da.display_name,
                        "region_or_zone": region,
                        "status": da.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "drg_id": da.drg_id,
                            # network_details is the current field; vcn_id /
                            # route_table_id on the model itself are deprecated
                            # in favor of it.
                            "attached_network_type": details.type if details else None,
                            "attached_network_id": details.id if details else None,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(da.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": da.freeform_tags or {},
                        "raw_data": {"id": da.id, "display_name": da.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Autonomous Databases ──────────────────────────────────────────────────

    async def _scan_databases(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            db = self._client_for_region(oci.database.DatabaseClient, region)
            results = []
            try:
                adbs = oci.pagination.list_call_get_all_results(
                    db.list_autonomous_databases, compartment_id
                ).data
                for adb in adbs:
                    if adb.lifecycle_state in ("TERMINATED",):
                        continue
                    results.append(
                        {
                            "provider_resource_id": adb.id,
                            "resource_type": "AutonomousDatabase",
                            "resource_name": adb.display_name,
                            "region_or_zone": region,
                            "status": adb.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "db_name": adb.db_name,
                                "cpu_core_count": adb.cpu_core_count,
                                # Newer ADBs bill on the ECPU model, where the OCPU
                                # cpu_core_count is 0 and the real capacity lives in
                                # compute_model/compute_count. Capture both so the UI
                                # never shows a misleading "cpu_core_count=0".
                                "compute_model": getattr(adb, "compute_model", None),
                                "compute_count": getattr(adb, "compute_count", None),
                                "data_storage_size_tbs": adb.data_storage_size_in_tbs,
                                "db_workload": adb.db_workload,
                                "is_auto_scaling_enabled": adb.is_auto_scaling_enabled,
                            },
                            "metadata": {
                                "time_created": str(adb.time_created),
                                "region": region,
                                "compartment_id": compartment_id,
                            },
                            "cost_monthly": None,
                            "tags": adb.freeform_tags or {},
                            "raw_data": {"id": adb.id, "display_name": adb.display_name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI ADB scan failed [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── DB Systems (classic VM / Bare Metal Oracle Database Cloud Service) ────
    # A completely separate OCI resource + billing line from Autonomous
    # Database — list_autonomous_databases never returns these, so an account
    # using classic DB Systems had them fully invisible: absent from inventory,
    # unmatched against real "DB System" billing rows, unscanned for security,
    # and missing from the topology graph, despite often being the single
    # largest cost line in the account.

    async def _scan_db_systems(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            db = self._client_for_region(oci.database.DatabaseClient, region)
            try:
                systems = oci.pagination.list_call_get_all_results(
                    db.list_db_systems, compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the sweep
                # look complete and let the caller prune live rows — the exact
                # mistake that once mis-recorded 21 real DynamoDB tables as
                # "none", except a DB System is usually far more expensive.
                self.scan_failures.append(f"DbSystem [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for sys_ in systems:
                if sys_.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": sys_.id,
                        "resource_type": "DbSystem",
                        "resource_name": sys_.display_name,
                        "region_or_zone": region,
                        "status": sys_.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "shape": sys_.shape,
                            "database_edition": sys_.database_edition,
                            "cpu_core_count": sys_.cpu_core_count,
                            "node_count": sys_.node_count,
                            "data_storage_size_gb": getattr(sys_, "data_storage_size_in_gbs", None),
                            "storage_performance_mode": getattr(sys_, "storage_volume_performance_mode", None),
                            "disk_redundancy": getattr(sys_, "disk_redundancy", None),
                            "license_model": sys_.license_model,
                            "availability_domain": sys_.availability_domain,
                            "subnet_id": sys_.subnet_id,
                            "nsg_ids": list(getattr(sys_, "nsg_ids", None) or []),
                            "hostname": sys_.hostname,
                            "listener_port": getattr(sys_, "listener_port", None),
                            "cluster_name": getattr(sys_, "cluster_name", None),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(sys_.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": sys_.freeform_tags or {},
                        "raw_data": {"id": sys_.id, "display_name": sys_.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── MySQL Database Service ────────────────────────────────────────────────
    # A genuinely separate OCI product from oci.database's Oracle DB Systems —
    # different client, different console page, different billing line — so it
    # was just as invisible as the classic DB Systems fixed above.
    async def _scan_mysql_db_systems(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            mysql = self._client_for_region(oci.mysql.DbSystemClient, region)
            try:
                systems = oci.pagination.list_call_get_all_results(
                    mysql.list_db_systems, compartment_id
                ).data
            except Exception as exc:
                self.scan_failures.append(f"MySQLDbSystem [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for summary in systems:
                if summary.lifecycle_state in ("DELETED",):
                    continue
                # list_db_systems returns DbSystemSummary, which has no
                # subnet_id/nsg_ids/storage size — those only exist on the
                # fuller DbSystem model from get_db_system. Without this second
                # call, every MySQL system would be discovered but unlinkable
                # to its network (no topology/exposure edges) and silently
                # missing its storage size.
                try:
                    s = mysql.get_db_system(summary.id).data
                except Exception:
                    s = summary  # degrade to the thinner summary rather than drop the resource
                endpoints = getattr(s, "endpoints", None) or []
                ip = next((e.ip_address for e in endpoints if getattr(e, "ip_address", None)), None)
                results.append(
                    {
                        "provider_resource_id": s.id,
                        "resource_type": "MySQLDbSystem",
                        "resource_name": s.display_name,
                        "region_or_zone": region,
                        "status": s.lifecycle_state,
                        "ip_address": ip,
                        "config": {
                            "shape": s.shape_name,
                            "mysql_version": getattr(s, "mysql_version", None),
                            "data_storage_size_gb": getattr(s, "data_storage_size_in_gbs", None),
                            "is_highly_available": getattr(s, "is_highly_available", None),
                            "availability_domain": s.availability_domain,
                            "subnet_id": getattr(s, "subnet_id", None),
                            "nsg_ids": list(getattr(s, "nsg_ids", None) or []),
                            "crash_recovery": getattr(s, "crash_recovery", None),
                            "backup_enabled": (
                                s.backup_policy.is_enabled if getattr(s, "backup_policy", None) else None
                            ),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(s.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": s.freeform_tags or {},
                        "raw_data": {"id": s.id, "display_name": s.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── NoSQL Database Service ─────────────────────────────────────────────────
    async def _scan_nosql_tables(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            nosql = self._client_for_region(oci.nosql.NosqlClient, region)
            try:
                # list_call_get_all_results already unwraps TableCollection.items
                # internally and returns a plain list — NOT the TableCollection
                # object list_tables() itself would return.
                tables = oci.pagination.list_call_get_all_results(
                    nosql.list_tables, compartment_id
                ).data
            except Exception as exc:
                self.scan_failures.append(f"NoSQLTable [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for t in tables:
                if t.lifecycle_state in ("DELETED",):
                    continue
                limits = getattr(t, "table_limits", None)
                results.append(
                    {
                        "provider_resource_id": t.id,
                        "resource_type": "NoSQLTable",
                        "resource_name": t.name,
                        "region_or_zone": region,
                        "status": t.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "max_read_units": getattr(limits, "max_read_units", None),
                            "max_write_units": getattr(limits, "max_write_units", None),
                            "max_storage_gb": getattr(limits, "max_storage_in_g_bs", None),
                            "capacity_mode": getattr(limits, "capacity_mode", None),
                            "is_auto_reclaimable": getattr(t, "is_auto_reclaimable", None),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(t.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": t.freeform_tags or {},
                        "raw_data": {"id": t.id, "name": t.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── VCN (Virtual Cloud Network) ───────────────────────────────────────────

    async def _scan_vcn(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                vcns = oci.pagination.list_call_get_all_results(
                    net.list_vcns, compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"VCN [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for vcn in vcns:
                if vcn.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": vcn.id,
                        "resource_type": "VCN",
                        "resource_name": vcn.display_name,
                        "region_or_zone": region,
                        "status": vcn.lifecycle_state,
                        "ip_address": vcn.cidr_block,
                        "config": {
                            "cidr_block": vcn.cidr_block,
                            "cidr_blocks": vcn.cidr_blocks or [],
                            "dns_label": vcn.dns_label,
                            "domain_name": vcn.vcn_domain_name,
                            "is_ipv6_enabled": getattr(vcn, "is_ipv6_enabled", False),
                            # OCI auto-creates one of each per VCN — these ids are
                            # how the route table / security list / DHCP options
                            # scanners below mark their own rows as default.
                            "default_route_table_id": vcn.default_route_table_id,
                            "default_security_list_id": vcn.default_security_list_id,
                            "default_dhcp_options_id": vcn.default_dhcp_options_id,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(vcn.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": vcn.freeform_tags or {},
                        "raw_data": {"id": vcn.id, "display_name": vcn.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Subnets ───────────────────────────────────────────────────────────────

    async def _scan_subnets(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        """Subnets, so instance and load-balancer placement resolves to something.

        Both compute (via its VNIC) and load balancers report a subnet OCID, but
        subnets were never discovered — so the whole subnet tier was missing from
        the topology and those references dangled.
        """
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                subnets = oci.pagination.list_call_get_all_results(
                    net.list_subnets, compartment_id=compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"Subnet [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for sn in subnets:
                if sn.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": sn.id,
                        "resource_type": "Subnet",
                        "resource_name": sn.display_name,
                        "region_or_zone": region,
                        "status": sn.lifecycle_state,
                        "ip_address": sn.cidr_block,
                        "config": {
                            # None for a regional subnet, which is the norm.
                            "availability_domain": sn.availability_domain,
                            "cidr_block": sn.cidr_block,
                            "vcn_id": sn.vcn_id,
                            "is_public": not sn.prohibit_public_ip_on_vnic,
                            "dns_label": sn.dns_label,
                            "route_table_id": sn.route_table_id,
                            "security_list_ids": list(sn.security_list_ids or []),
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(sn.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": sn.freeform_tags or {},
                        "raw_data": {"id": sn.id, "display_name": sn.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Security Lists ────────────────────────────────────────────────────────
    # OCI auto-creates one "Default Security List" per VCN, and it is what
    # actually governs traffic for a subnet that has no NSG attached — the older,
    # subnet-level firewall mechanism that predates NSGs. Not scanning this left
    # every instance relying on it reading as "unknown exposure" (a genuine
    # unknown, not a bug — see exposure_service.py), and it is also the source of
    # OCI's other "default" objects a user would want to filter out, matching
    # AWS's default VPC/security group and Azure's default subnet.

    async def _scan_security_lists(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                vcns = oci.pagination.list_call_get_all_results(
                    net.list_vcns, compartment_id
                ).data
                default_ids = {v.default_security_list_id for v in vcns if v.default_security_list_id}
                seclists = oci.pagination.list_call_get_all_results(
                    net.list_security_lists, compartment_id
                ).data
            except Exception as exc:
                self.scan_failures.append(f"SecurityList [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for sl in seclists:
                if sl.lifecycle_state in ("TERMINATED",):
                    continue

                def _rules(rule_list, is_ingress):
                    out = []
                    for rule in rule_list or []:
                        parsed = {
                            "protocol": rule.protocol,
                            "is_stateless": rule.is_stateless,
                            "port_range": _oci_port_range(rule),
                        }
                        if is_ingress:
                            parsed["source"] = rule.source
                            parsed["source_type"] = rule.source_type
                        else:
                            parsed["destination"] = rule.destination
                            parsed["destination_type"] = rule.destination_type
                        out.append(parsed)
                    return out

                # Same shape as NSG's ingress_rules/egress_rules on purpose —
                # exposure_service.py's _oci_open_ports() reads either without
                # needing to know which mechanism it came from.
                ingress = _rules(sl.ingress_security_rules, True)
                egress = _rules(sl.egress_security_rules, False)
                results.append(
                    {
                        "provider_resource_id": sl.id,
                        "resource_type": "SecurityList",
                        "resource_name": sl.display_name,
                        "region_or_zone": region,
                        "status": sl.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "vcn_id": sl.vcn_id,
                            "total_rules": len(ingress) + len(egress),
                            "ingress_rules": ingress,
                            "egress_rules": egress,
                            "is_default": sl.id in default_ids,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(sl.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": sl.freeform_tags or {},
                        "raw_data": {"id": sl.id, "display_name": sl.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Route Tables ──────────────────────────────────────────────────────────

    async def _scan_route_tables(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                vcns = oci.pagination.list_call_get_all_results(
                    net.list_vcns, compartment_id
                ).data
                default_ids = {v.default_route_table_id for v in vcns if v.default_route_table_id}
                tables = oci.pagination.list_call_get_all_results(
                    net.list_route_tables, compartment_id
                ).data
            except Exception as exc:
                self.scan_failures.append(f"RouteTable [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for rt in tables:
                if rt.lifecycle_state in ("TERMINATED",):
                    continue
                rules = [
                    {
                        "destination": r.destination,
                        "destination_type": r.destination_type,
                        "network_entity_id": r.network_entity_id,
                        "route_type": r.route_type,
                    }
                    for r in (rt.route_rules or [])
                ]
                results.append(
                    {
                        "provider_resource_id": rt.id,
                        "resource_type": "RouteTable",
                        "resource_name": rt.display_name,
                        "region_or_zone": region,
                        "status": rt.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "vcn_id": rt.vcn_id,
                            "route_rule_count": len(rules),
                            "route_rules": rules,
                            "is_default": rt.id in default_ids,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(rt.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": rt.freeform_tags or {},
                        "raw_data": {"id": rt.id, "display_name": rt.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── DHCP Options ──────────────────────────────────────────────────────────

    async def _scan_dhcp_options(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                vcns = oci.pagination.list_call_get_all_results(
                    net.list_vcns, compartment_id
                ).data
                default_ids = {v.default_dhcp_options_id for v in vcns if v.default_dhcp_options_id}
                opts_list = oci.pagination.list_call_get_all_results(
                    net.list_dhcp_options, compartment_id
                ).data
            except Exception as exc:
                self.scan_failures.append(f"DhcpOptions [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for opts in opts_list:
                if opts.lifecycle_state in ("TERMINATED",):
                    continue
                results.append(
                    {
                        "provider_resource_id": opts.id,
                        "resource_type": "DhcpOptions",
                        "resource_name": opts.display_name,
                        "region_or_zone": region,
                        "status": opts.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "vcn_id": opts.vcn_id,
                            "domain_name_type": opts.domain_name_type,
                            "is_default": opts.id in default_ids,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(opts.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": opts.freeform_tags or {},
                        "raw_data": {"id": opts.id, "display_name": opts.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Network Security Groups (NSG) ─────────────────────────────────────────

    async def _scan_nsg(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            net = self._client_for_region(oci.core.VirtualNetworkClient, region)
            try:
                nsgs = oci.pagination.list_call_get_all_results(
                    net.list_network_security_groups, compartment_id=compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"NSG [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for nsg in nsgs:
                if nsg.lifecycle_state in ("TERMINATED",):
                    continue
                # The actual rules, not just a count. Internet-exposure analysis
                # needs to know WHICH ports are open to WHICH source — "1 ingress
                # rule" answers neither question, so it was discarded right after
                # being fetched even though the API call had already paid for it.
                ingress: List[Dict[str, Any]] = []
                egress: List[Dict[str, Any]] = []
                try:
                    for rule in net.list_network_security_group_security_rules(nsg.id).data:
                        parsed = {
                            "protocol": rule.protocol,  # "6"=TCP "17"=UDP "1"=ICMP "all"
                            "is_stateless": rule.is_stateless,
                            "port_range": _oci_port_range(rule),
                        }
                        if rule.direction == "INGRESS":
                            parsed["source"] = rule.source
                            parsed["source_type"] = rule.source_type
                            ingress.append(parsed)
                        else:
                            parsed["destination"] = rule.destination
                            parsed["destination_type"] = rule.destination_type
                            egress.append(parsed)
                except Exception as exc:
                    logger.debug("NSG rules fetch failed for %s: %s", nsg.id, exc)

                results.append(
                    {
                        "provider_resource_id": nsg.id,
                        "resource_type": "NetworkSecurityGroup",
                        "resource_name": nsg.display_name,
                        "region_or_zone": region,
                        "status": nsg.lifecycle_state,
                        "ip_address": None,
                        "config": {
                            "vcn_id": nsg.vcn_id,
                            "total_rules": len(ingress) + len(egress),
                            "ingress_rules": ingress,
                            "egress_rules": egress,
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(nsg.time_created),
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": nsg.freeform_tags or {},
                        "raw_data": {"id": nsg.id, "display_name": nsg.display_name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Load Balancers ────────────────────────────────────────────────────────

    async def _scan_load_balancers(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            results = []

            # 1. Classic Load Balancers
            try:
                lb_client = self._client_for_region(oci.load_balancer.LoadBalancerClient, region)
                lbs = oci.pagination.list_call_get_all_results(
                    lb_client.list_load_balancers, compartment_id
                ).data
                for lb in lbs:
                    if lb.lifecycle_state in ("DELETED",):
                        continue
                    # Collect IP addresses
                    ips = [
                        ip.ip_address
                        for ip in (lb.ip_addresses or [])
                        if ip.ip_address
                    ]
                    results.append(
                        {
                            "provider_resource_id": lb.id,
                            "resource_type": "LoadBalancer",
                            "resource_name": lb.display_name,
                            "region_or_zone": region,
                            "status": lb.lifecycle_state,
                            "ip_address": ips[0] if ips else None,
                            "config": {
                                "shape_name": lb.shape_name,
                                "is_private": lb.is_private,
                                "ip_addresses": ips,
                                "subnet_ids": lb.subnet_ids or [],
                                "backend_sets": list((lb.backend_sets or {}).keys()),
                                # The actual backends behind those sets. Only the
                                # set *names* were stored before, which name nothing
                                # resolvable — so a load balancer had no downstream
                                # edge to whatever it serves traffic to.
                                "backend_ips": sorted({
                                    b.ip_address
                                    for bs in (lb.backend_sets or {}).values()
                                    for b in (getattr(bs, "backends", None) or [])
                                    if getattr(b, "ip_address", None)
                                }),
                                "listeners": list((lb.listeners or {}).keys()),
                                "lb_type": "LoadBalancer",
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(lb.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": lb.freeform_tags or {},
                            "raw_data": {"id": lb.id, "display_name": lb.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI LoadBalancer scan [%s/%s]: %s", region, compartment_id[:20], exc)

            # 2. Network Load Balancers
            try:
                nlb_client = self._client_for_region(
                    oci.network_load_balancer.NetworkLoadBalancerClient, region
                )
                nlbs = oci.pagination.list_call_get_all_results(
                    nlb_client.list_network_load_balancers, compartment_id
                ).data
                for nlb in nlbs:
                    if nlb.lifecycle_state in ("DELETED",):
                        continue
                    ips = [
                        ip.ip_address
                        for ip in (nlb.ip_addresses or [])
                        if ip.ip_address
                    ]
                    results.append(
                        {
                            "provider_resource_id": nlb.id,
                            "resource_type": "NetworkLoadBalancer",
                            "resource_name": nlb.display_name,
                            "region_or_zone": region,
                            "status": nlb.lifecycle_state,
                            "ip_address": ips[0] if ips else None,
                            "config": {
                                "is_private": nlb.is_private,
                                "ip_addresses": ips,
                                "subnet_id": nlb.subnet_id,
                                "lb_type": "NetworkLoadBalancer",
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(nlb.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": nlb.freeform_tags or {},
                            "raw_data": {"id": nlb.id, "display_name": nlb.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI NLB scan [%s/%s]: %s", region, compartment_id[:20], exc)

            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── OCI Functions ─────────────────────────────────────────────────────────

    async def _scan_functions(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            fn_client = self._client_for_region(
                oci.functions.FunctionsManagementClient, region
            )
            results = []
            try:
                # List applications first, then functions within each
                apps = oci.pagination.list_call_get_all_results(
                    fn_client.list_applications, compartment_id
                ).data
                for app in apps:
                    if app.lifecycle_state in ("DELETED",):
                        continue
                    try:
                        functions = oci.pagination.list_call_get_all_results(
                            fn_client.list_functions, app.id
                        ).data
                        for fn in functions:
                            if fn.lifecycle_state in ("DELETED",):
                                continue
                            results.append(
                                {
                                    "provider_resource_id": fn.id,
                                    "resource_type": "Function",
                                    "resource_name": fn.display_name,
                                    "region_or_zone": region,
                                    "status": fn.lifecycle_state,
                                    "ip_address": fn.invoke_endpoint,
                                    "config": {
                                        "application_id": app.id,
                                        "application_name": app.display_name,
                                        "image": fn.image,
                                        "image_digest": fn.image_digest,
                                        "memory_in_mbs": fn.memory_in_mbs,
                                        "timeout_in_seconds": fn.timeout_in_seconds,
                                        "invoke_endpoint": fn.invoke_endpoint,
                                    },
                                    "metadata": {
                                        "compartment_id": compartment_id,
                                        "time_created": str(fn.time_created),
                                        "region": region,
                                    },
                                    "cost_monthly": None,
                                    "tags": fn.freeform_tags or {},
                                    "raw_data": {
                                        "id": fn.id,
                                        "display_name": fn.display_name,
                                        "application_id": app.id,
                                    },
                                }
                            )
                    except Exception as exc:
                        logger.debug("OCI Functions list [app=%s]: %s", app.id[:20], exc)
            except Exception as exc:
                logger.debug("OCI Functions Applications scan [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── OKE (Container Engine for Kubernetes) ─────────────────────────────────

    async def _scan_oke(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            oke_client = self._client_for_region(
                oci.container_engine.ContainerEngineClient, region
            )
            try:
                clusters = oci.pagination.list_call_get_all_results(
                    oke_client.list_clusters, compartment_id
                ).data
            except Exception as exc:
                # Record before bailing: a silent [] here would make the
                # sweep look complete and let the caller prune live rows.
                self.scan_failures.append(f"OKE [{region}]: {str(exc)[:160]}")
                return []
            results = []
            for cluster in clusters:
                if cluster.lifecycle_state in ("DELETED",):
                    continue
                # Fetch node pool count
                try:
                    node_pools = oke_client.list_node_pools(
                        compartment_id, cluster_id=cluster.id
                    ).data
                    node_pool_count = len(node_pools)
                except Exception:
                    node_pool_count = 0

                endpoint = None
                if cluster.endpoints:
                    endpoint = cluster.endpoints.public_endpoint or cluster.endpoints.private_endpoint

                results.append(
                    {
                        "provider_resource_id": cluster.id,
                        "resource_type": "OKECluster",
                        "resource_name": cluster.name,
                        "region_or_zone": region,
                        "status": cluster.lifecycle_state,
                        "ip_address": endpoint,
                        "config": {
                            "kubernetes_version": cluster.kubernetes_version,
                            "vcn_id": cluster.vcn_id,
                            "node_pool_count": node_pool_count,
                            "endpoint": endpoint,
                            "endpoint_config": {
                                "is_public_ip_enabled": getattr(
                                    cluster.endpoint_config, "is_public_ip_enabled", None
                                ) if cluster.endpoint_config else None,
                            },
                        },
                        "metadata": {
                            "compartment_id": compartment_id,
                            "time_created": str(cluster.metadata.time_created) if cluster.metadata else None,
                            "region": region,
                        },
                        "cost_monthly": None,
                        "tags": cluster.freeform_tags or {},
                        "raw_data": {"id": cluster.id, "name": cluster.name},
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── API Gateway ───────────────────────────────────────────────────────────

    async def _scan_api_gateway(self, compartment_id: str, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            gw_client = self._client_for_region(oci.apigateway.GatewayClient, region)
            deploy_client = self._client_for_region(oci.apigateway.DeploymentClient, region)
            results = []

            try:
                gateways = oci.pagination.list_call_get_all_results(
                    gw_client.list_gateways, compartment_id
                ).data
                for gw in gateways:
                    if gw.lifecycle_state in ("DELETED",):
                        continue

                    # Fetch deployments for this gateway
                    try:
                        deployments = oci.pagination.list_call_get_all_results(
                            deploy_client.list_deployments,
                            compartment_id,
                            gateway_id=gw.id,
                        ).data
                        deployment_names = [d.display_name for d in deployments if d.lifecycle_state != "DELETED"]
                    except Exception:
                        deployment_names = []

                    results.append(
                        {
                            "provider_resource_id": gw.id,
                            "resource_type": "APIGateway",
                            "resource_name": gw.display_name,
                            "region_or_zone": region,
                            "status": gw.lifecycle_state,
                            "ip_address": gw.hostname,
                            "config": {
                                "endpoint_type": gw.endpoint_type,
                                "hostname": gw.hostname,
                                "subnet_id": gw.subnet_id,
                                "certificate_id": gw.certificate_id,
                                "deployments": deployment_names,
                                "deployment_count": len(deployment_names),
                            },
                            "metadata": {
                                "compartment_id": compartment_id,
                                "time_created": str(gw.time_created),
                                "region": region,
                            },
                            "cost_monthly": None,
                            "tags": gw.freeform_tags or {},
                            "raw_data": {"id": gw.id, "display_name": gw.display_name},
                        }
                    )
            except Exception as exc:
                logger.debug("OCI API Gateway scan [%s/%s]: %s", region, compartment_id[:20], exc)
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── IAM Groups & Policies (global, no region loop) ────────────────────────

    async def _scan_iam_groups(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            identity = self._identity_client()
            results = []

            # Groups
            try:
                groups = oci.pagination.list_call_get_all_results(
                    identity.list_groups, self.auth.tenancy_ocid
                ).data
                for grp in groups:
                    if grp.lifecycle_state in ("DELETED",):
                        continue
                    # Count members
                    try:
                        memberships = identity.list_user_group_memberships(
                            self.auth.tenancy_ocid, group_id=grp.id
                        ).data
                        member_count = len(memberships)
                    except Exception:
                        member_count = 0

                    results.append(
                        {
                            "provider_resource_id": grp.id,
                            "resource_type": "IAMGroup",
                            "resource_name": grp.name,
                            "region_or_zone": "global",
                            "status": grp.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "description": grp.description,
                                "member_count": member_count,
                            },
                            "metadata": {
                                "time_created": str(grp.time_created),
                                "compartment_id": self.auth.tenancy_ocid,
                            },
                            "cost_monthly": None,
                            "tags": grp.freeform_tags or {},
                            "raw_data": {"id": grp.id, "name": grp.name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI IAM Groups scan failed: %s", exc)

            # Policies
            try:
                policies = oci.pagination.list_call_get_all_results(
                    identity.list_policies, self.auth.tenancy_ocid
                ).data
                for pol in policies:
                    if pol.lifecycle_state in ("DELETED",):
                        continue
                    results.append(
                        {
                            "provider_resource_id": pol.id,
                            "resource_type": "IAMPolicy",
                            "resource_name": pol.name,
                            "region_or_zone": "global",
                            "status": pol.lifecycle_state,
                            "ip_address": None,
                            "config": {
                                "description": pol.description,
                                "statement_count": len(pol.statements or []),
                                "statements": pol.statements or [],
                            },
                            "metadata": {
                                "time_created": str(pol.time_created),
                                "compartment_id": pol.compartment_id,
                            },
                            "cost_monthly": None,
                            "tags": pol.freeform_tags or {},
                            "raw_data": {"id": pol.id, "name": pol.name},
                        }
                    )
            except Exception as exc:
                logger.warning("OCI IAM Policies scan failed: %s", exc)

            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Main scan_all ─────────────────────────────────────────────────────────

    async def scan_all(self, on_batch=None) -> List[Dict[str, Any]]:
        """Scan ALL resource types across ALL subscribed OCI regions in parallel.

        If on_batch is provided, it is awaited with each non-empty batch of
        resources as it is discovered, so the caller can persist incrementally
        and report live progress. Concurrent batches are fine — the caller is
        responsible for serializing its own writes.
        """
        # Discover regions and compartments concurrently
        regions, compartments = await asyncio.gather(
            self._get_subscribed_regions(),
            self._get_compartments(),
        )
        logger.info(
            "OCI scanning %d regions × %d compartments",
            len(regions),
            len(compartments),
        )
        all_resources: List[Dict[str, Any]] = []
        permission_errors = []

        def _stamp(batch):
            # Add the readable compartment name alongside the OCID so the
            # topology graph can label compartment hubs (mutates in place, so
            # both the emitted batch and all_resources get it).
            for r in batch:
                meta = r.get("metadata") or {}
                cid = meta.get("compartment_id")
                if cid and not meta.get("compartment_name"):
                    meta["compartment_name"] = self._compartment_names.get(cid)
                    r["metadata"] = meta

        async def _emit(batch):
            if not batch:
                return
            _stamp(batch)
            if on_batch:
                try:
                    await on_batch(batch)
                except Exception as cb_exc:
                    logger.warning("OCI on_batch callback failed: %s", cb_exc)

        self.scan_failures = []
        if not regions:
            self.scan_failures.append("region discovery returned nothing")
        if not compartments:
            self.scan_failures.append("compartment discovery returned nothing")

        # IAM is global (single region call)
        try:
            iam_resources = await self._scan_iam_groups()
            all_resources.extend(iam_resources)
            logger.info("OCI IAM: found %d resources", len(iam_resources))
            await _emit(iam_resources)
        except Exception as exc:
            logger.warning("OCI IAM scan failed: %s", exc)
            self.scan_failures.append(f"IAM: {exc}")
            if "NotAuthorizedOrNotFound" in str(exc) or "Authorization failed" in str(exc):
                permission_errors.append(str(exc))

        # Per-region per-compartment scanners
        PER_REGION_SCANNERS = [
            (self._scan_compute,        "Compute"),
            (self._scan_block_volumes,  "BlockVolume"),
            (self._scan_boot_volumes,   "BootVolume"),
            (self._scan_object_storage, "ObjectStorage"),
            (self._scan_file_systems,   "FileSystem"),
            (self._scan_databases,      "Database"),
            (self._scan_db_systems,     "DbSystem"),
            (self._scan_mysql_db_systems, "MySQLDbSystem"),
            (self._scan_nosql_tables,   "NoSQLTable"),
            (self._scan_analytics_instances, "AnalyticsInstance"),
            (self._scan_vcn,            "VCN"),
            (self._scan_subnets,        "Subnet"),
            (self._scan_security_lists, "SecurityList"),
            (self._scan_route_tables,   "RouteTable"),
            (self._scan_dhcp_options,   "DhcpOptions"),
            (self._scan_nsg,            "NSG"),
            (self._scan_load_balancers, "LoadBalancer"),
            (self._scan_waf,            "WebAppFirewall"),
            (self._scan_virtual_circuits, "VirtualCircuit"),
            (self._scan_drg_attachments, "DrgAttachment"),
            (self._scan_functions,      "Functions"),
            (self._scan_oke,            "OKE"),
            (self._scan_api_gateway,    "APIGateway"),
        ]

        # regions × compartments × scanners is a large product (20 compartments
        # over 2 regions with 10 scanners = 400). Launching all of them at once
        # opens hundreds of simultaneous TLS connections and DNS lookups, which
        # in practice swamps the local resolver and trips connection-aborting
        # security software — surfacing as getaddrinfo failures, SSL EOFs and
        # ConnectionAborted(10053) rather than any real OCI error. Bounding the
        # in-flight count makes the sweep reliable (and usually no slower, since
        # the failures were costing full retry/timeout cycles).
        sem = asyncio.Semaphore(self._MAX_CONCURRENT_SCANS)

        async def _run(scanner_fn, compartment_id: str, region: str, label: str):
            async with sem:
                try:
                    results = await scanner_fn(compartment_id, region)
                    if results:
                        logger.info(
                            "OCI %s [%s/%s]: %d resources",
                            label, region, compartment_id[:20], len(results),
                        )
                        await _emit(results)
                    return results
                except Exception as exc:
                    logger.warning("OCI %s [%s/%s] failed: %s", label, region, compartment_id[:20], exc)
                    self.scan_failures.append(f"{label} [{region}]: {str(exc)[:160]}")
                    if "NotAuthorizedOrNotFound" in str(exc) or "Authorization failed" in str(exc):
                        permission_errors.append(str(exc))
                    return []

        tasks = [
            _run(scanner_fn, cid, region, label)
            for region in regions
            for cid in compartments
            for scanner_fn, label in PER_REGION_SCANNERS
        ]

        if tasks:
            results_list = await asyncio.gather(*tasks)
            for results in results_list:
                all_resources.extend(results)

        logger.info("OCI total resources discovered: %d", len(all_resources))
        if self.scan_failures:
            logger.warning(
                "OCI sweep INCOMPLETE — %d scope(s) failed to enumerate; the caller must "
                "not prune against this result. First few: %s",
                len(self.scan_failures), self.scan_failures[:3],
            )

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required IAM permissions (Read-Only). Oracle Cloud returned NotAuthorizedOrNotFound during the scan.")

        return all_resources
