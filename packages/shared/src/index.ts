// ===== 크롤링 관련 타입 =====

export interface Product {
  modelName: string;
  productName: string;
  sellerName: string;
  couponPrice: number | null;
  regularPrice: number | null;
  shippingFee: number | null;
  discountPercent: number | null;
  productUrl: string;
  searchUrl?: string;
  rank: number;
  crawledAt: Date;
  clusterSize?: number;
}

export interface SearchResult {
  modelName: string;
  products: Product[];
  searchUrl?: string;
  error?: string;
}

// ===== Job 관련 타입 =====

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type JobItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  user_id: string;
  status: JobStatus;
  total_models: number;
  completed_models: number;
  failed_models: number;
  result_file_path: string | null;
  result_format: 'excel' | 'csv';
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface JobItem {
  id: string;
  job_id: string;
  model_name: string;
  status: JobItemStatus;
  result: Product[] | null;
  error_message: string | null;
  sequence: number;
  processed_at: string | null;
}

export interface JobWithItems extends Job {
  items: JobItem[];
}

// ===== API 요청/응답 타입 =====

export interface CreateJobRequest {
  models: string[];
  format?: 'excel' | 'csv';
}

export interface CreateJobResponse {
  jobId: string;
  totalModels: number;
}

export interface JobProgressResponse {
  job: Job;
  items: JobItem[];
}

// ===== 유틸리티 함수 =====

export function getTotalPrice(product: Product): number | null {
  const basePrice = product.couponPrice ?? product.regularPrice;
  if (basePrice === null) return null;
  return basePrice + (product.shippingFee ?? 0);
}

export function getLowestPriceProduct(products: Product[]): Product | null {
  const valid = products.filter(p => getTotalPrice(p) !== null);
  if (valid.length === 0) return null;

  if (valid.length <= 1) {
    const product = valid[0] || null;
    if (product) {
      product.clusterSize = 1;
    }
    return product;
  }

  const sorted = [...valid].sort((a, b) => getTotalPrice(a)! - getTotalPrice(b)!);

  const clusters: Product[][] = [];
  let currentCluster: Product[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevPrice = getTotalPrice(sorted[i - 1])!;
    const currPrice = getTotalPrice(sorted[i])!;
    const diff = (currPrice - prevPrice) / prevPrice;

    if (diff <= 0.3) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  const validClusters = clusters.filter(c => c.length >= 3);

  if (validClusters.length > 0) {
    const largestCluster = validClusters.reduce((max, c) =>
      c.length > max.length ? c : max
    );
    const product = largestCluster[0];
    product.clusterSize = largestCluster.length;
    return product;
  }

  const largestCluster = clusters.reduce((max, c) =>
    c.length > max.length ? c : max
  );
  const product = largestCluster[0];
  product.clusterSize = largestCluster.length;
  return product;
}
