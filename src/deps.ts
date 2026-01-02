// src/deps.ts

// -----------------------------
// Interfaces for models (generic, no Mongoose dependency)
// -----------------------------
export interface ICallRailCustomer {
  _id: string;
  tags?: string[];
  created_at?: Date | string;
  customer_phone_number?: string;
  duration?: string;
  // Add more fields as needed
}

export interface IHcpJob {
  hcpId?: string;
  callrailCustomerId?: string;
  companyId?: string;
  jobComponents?: any[];
  jobStatus?: string;
  schedule?: any;
  completed_at?: Date;
  customer?: any;
  assigned_employees?: any[];
  jobCategory?: string;
  jobType?: string;
  created_at?: Date;
  updated_at?: Date;
  revenue?: number;
  matchReason?: string;
  matchDetails?: string;
  average?: any;
  // Add more fields as needed
}

export interface IHcpEstimate {
  estimateId?: string;
  callrailCustomerId?: string;
  companyId?: string;
  created_at?: Date;
  // Add more fields as needed
}

export interface IHistoricalAverage {
  overallAverageRevenue: number;
  sourceAverages: Record<string, number>;
  subSourceAverages: Record<string, number>;
  date: Date;
  companyId: string;
  [key: string]: any;
}

// -----------------------------
// Dependency interface (updated to support query chaining for Mongoose-like methods)
// -----------------------------
export interface JobProcessorDeps {
  CallRailCustomer: {
    findOneAndUpdate: (query: any, update: any) => Promise<any>;
    find: (query: any) => Promise<any[]>;
  };

  HcpJob: {
    findOne: (query: any) => Promise<any>; // No chaining needed here
    updateOne: (query: any, update: any) => Promise<any>;
    save: (doc: any) => Promise<any>;
    new: (data: any) => any;
  };

  HcpEstimate: {
    findOne: (query: any) => Promise<any>;
  };

  HistoricalAverage: {
    // Updated to support chaining .lean() and .sort()
    findOne: (query: any) => {
      lean: () => Promise<any>;
      sort: (sort: any) => {
        lean: () => Promise<any>;
      };
    };
  };

  // Utility functions
  calculateLostRevenueInJob: (jobId: string, job: any, jobStatus: string, callrailCustomer: any, company: any) => Promise<void>;
  findBestCallrailCustomer: (calls: any[], jobDate: Date, isLinkedFn: (id: string) => Promise<boolean>, source: string, jobId: string) => Promise<{ call: any; matchReason: string; matchDetails: any }>;
  getLatLonFromGeocode: (address: any) => Promise<any>;
  normalizePhone: (phone: string) => string;
  normalizeDate: (date: string) => Date;
  findMostRecentLinkedCallJob: (uniqueCallrailCustomers: any[], jobTimestamp: Date, companyId: string) => Promise<any>;
}

// -----------------------------
// Optional: empty placeholder for runtime injection
// -----------------------------
export const deps: JobProcessorDeps = {} as any;