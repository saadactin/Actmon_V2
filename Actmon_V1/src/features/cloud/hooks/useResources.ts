import { useQuery } from '@tanstack/react-query';
import { getResources, getResourceDetail, getAllResources, getResourceMetrics } from '../api/resources.api';
import { CloudResource, CloudResourceDetail } from '../types/resource';
import { useCloudStore } from '../state/cloudStore';

// While any discovery scan is active, the backend persists resources in batches
// as they are found; poll every 10s so newly-discovered rows appear live. When
// no scan is running the query is not polled (refetchInterval false).
const LIVE_REFETCH_MS = 10_000;

export const useResources = (accountId: string | null) => {
  const isDiscovering = useCloudStore((s) => Object.keys(s.activeDiscoveryJobs).length > 0);
  return useQuery<CloudResource[]>({
    queryKey: ['resources', accountId],
    queryFn: () => (accountId ? getResources(accountId) : Promise.resolve([])),
    enabled: !!accountId,
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useAllResources = () => {
  const isDiscovering = useCloudStore((s) => Object.keys(s.activeDiscoveryJobs).length > 0);
  return useQuery<CloudResource[]>({
    queryKey: ['allResources'],
    queryFn: () => getAllResources(),
    refetchInterval: isDiscovering ? LIVE_REFETCH_MS : false,
  });
};

export const useResourceDetail = (resourceId: string | null) => {
  return useQuery<CloudResourceDetail | null>({
    queryKey: ['resourceDetail', resourceId],
    queryFn: () => (resourceId ? getResourceDetail(resourceId) : Promise.resolve(null)),
    enabled: !!resourceId,
  });
};

export const useResourceMetrics = (resourceId: string | null) => {
  return useQuery<any>({
    queryKey: ['resourceMetrics', resourceId],
    queryFn: () => (resourceId ? getResourceMetrics(resourceId) : Promise.resolve(null)),
    enabled: !!resourceId,
    staleTime: 30_000,
  });
};


