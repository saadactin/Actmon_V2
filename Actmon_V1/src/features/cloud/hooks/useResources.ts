import { useQuery } from '@tanstack/react-query';
import { getResources, getResourceDetail, getAllResources, getResourceMetrics } from '../api/resources.api';
import { CloudResource, CloudResourceDetail } from '../types/resource';

export const useResources = (accountId: string | null) => {
  return useQuery<CloudResource[]>({
    queryKey: ['resources', accountId],
    queryFn: () => (accountId ? getResources(accountId) : Promise.resolve([])),
    enabled: !!accountId,
  });
};

export const useAllResources = () => {
  return useQuery<CloudResource[]>({
    queryKey: ['allResources'],
    queryFn: () => getAllResources(),
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


